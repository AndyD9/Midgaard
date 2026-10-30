/**
 * @file Gérant des tâches : la machine à états en marche, et la frontière avec
 * les exécutants.
 *
 * Ce module garde **tout ce qui ne dépend pas de l'exécutant** : création,
 * transitions, décisions humaines, expirations, annulation, attente bloquante.
 * Ce qui se passe entre le démarrage et la fin appartient à un
 * {@link TaskEngine} — étapes minutées pour le profil simulé, boucle modèle pour
 * un agent réel.
 *
 * Cette coupure est l'encaissement du pari de la Slice 1, qui avait conçu
 * `tick()` pour être remplacé sans toucher au reste. Elle l'a été ; le reste n'a
 * pas bougé.
 *
 * Toutes les écritures passent par le bus ({@link EventBus}), jamais par le
 * dépôt directement : c'est ce qui garantit qu'aucun changement d'état n'échappe
 * aux long-polls ni aux dashboards connectés.
 */
import type {
  Agent,
  Approval,
  HarnessConfig,
  RequestedLimits,
  Task,
  TaskEvent,
  ToolCall,
} from '@midgaard/contracts'
import {
  SIMULATED_AGENT_ID,
  isActionable,
  isTerminal,
  nextActionFor,
  operationHash,
  tightenLimits,
} from '@midgaard/contracts'
import type { HarnessStore } from '@midgaard/persistence'
import type { EventBus } from './bus.ts'
import { SimulatedEngine, STEPS_TOTAL } from './engines/simulated.ts'
import type { EngineContext, TaskEngine } from './engines/types.ts'

export { STEPS_TOTAL, APPROVAL_STEP } from './engines/simulated.ts'

/**
 * Intervalle maximal de balayage des approbations expirées.
 *
 * Le balayage s'adapte au délai configuré : avec un délai court, attendre
 * quinze secondes pour constater une expiration de deux secondes rendrait le
 * comportement intestable.
 */
const MAX_EXPIRY_SWEEP_MS = 15_000

/** Issue d'une opération refusée, à traduire en code HTTP par l'appelant. */
export interface Refusal {
  error: string
  status: number
  detail?: Record<string, unknown>
}

/** Vue d'une tâche enrichie de sa consigne et de son approbation en cours. */
export interface TaskView {
  task: Task
  next_action: ReturnType<typeof nextActionFor>
  approval: Approval | null
}

/** Pilote les tâches et applique la machine à états. */
export class TaskManager {
  private readonly config: HarnessConfig
  private readonly store: HarnessStore
  private readonly bus: EventBus
  private readonly log: (...a: unknown[]) => void
  private readonly engines = new Map<string, TaskEngine>()
  private sweeper: NodeJS.Timeout | null = null

  constructor(config: HarnessConfig, store: HarnessStore, bus: EventBus, log: (...a: unknown[]) => void) {
    this.config = config
    this.store = store
    this.bus = bus
    this.log = log
    this.register(new SimulatedEngine(this.engineContextFor()))
  }

  /**
   * Déclare un moteur pour un type de profil.
   *
   * Le moteur simulé est enregistré par le constructeur ; le daemon ajoute celui
   * des agents réels une fois le coffre ouvert et les fournisseurs lus. Un profil
   * dont le moteur n'est pas enregistré refuse les délégations plutôt que de
   * faire semblant de démarrer.
   */
  register(engine: TaskEngine): void {
    this.engines.set(engine.kind, engine)
  }

  /**
   * Ce que les moteurs empruntent au daemon.
   *
   * Public pour que le daemon puisse construire le moteur des agents réels, qui
   * a besoin de dépendances que le gérant n'a pas à connaître — le coffre et la
   * table de tarifs.
   */
  engineContextFor(): EngineContext {
    return {
      config: this.config,
      store: this.store,
      bus: this.bus,
      log: this.log,
      requestApproval: (taskId, operation, detail, payload) => this.openApproval(taskId, operation, detail, payload),
      concludeCancellation: (taskId) => {
        this.finishCancellation(taskId)
      },
    }
  }

  /**
   * À appeler une fois au démarrage du daemon, **avant** d'accepter des requêtes.
   *
   * Toute tâche trouvée active vient d'un processus mort : ses minuteurs
   * n'existent plus et rien ne la reprendra. Elle est marquée `interrupted`,
   * jamais reprise ni considérée réussie.
   *
   * @returns le nombre de tâches interrompues
   */
  recoverFromRestart(): number {
    const interrupted = this.store.markInterrupted()
    if (interrupted.length) {
      this.log(`${interrupted.length} tâche(s) trouvée(s) en cours au démarrage → interrupted`)
    }
    // Les approbations encore en attente portent sur des tâches désormais
    // interrompues : les laisser « en attente » afficherait un bouton d'approbation
    // qui ne peut plus rien débloquer.
    for (const a of this.store.pendingApprovals()) {
      const resolved = this.store.resolveApproval(a.id, 'expired', 'daemon', 'daemon redémarré')
      if (resolved) this.bus.emitApproval(resolved)
    }
    // Les worktrees de ces tâches sont conservés pour inspection, jamais
    // nettoyés d'office : ce qu'ils contiennent est peut-être la seule trace de
    // ce que l'agent avait fait (PLAN §3).
    const kept = this.bus.keepActiveWorkspaces()
    if (kept.length) this.log(`${kept.length} worktree(s) d'une tâche interrompue conservé(s) pour inspection`)
    const sweepMs = Math.min(MAX_EXPIRY_SWEEP_MS, Math.max(500, Math.round(this.config.approvalTtlMs / 2)))
    this.sweeper = setInterval(() => this.expireDueApprovals(), sweepMs)
    this.sweeper.unref()
    return interrupted.length
  }

  /** Arrête tous les moteurs. L'état reste en base ; les tâches actives seront
   * marquées `interrupted` au prochain démarrage. */
  stop(): void {
    for (const engine of this.engines.values()) engine.stop()
    if (this.sweeper) clearInterval(this.sweeper)
  }

  // --- Cycle de vie --------------------------------------------------------

  /**
   * Crée une tâche et la confie au moteur de son profil.
   *
   * Les refus arrivent **avant** la création : une tâche créée puis échouée
   * aussitôt parce que son agent n'existe pas pollue l'historique et oblige
   * Claude à lire un statut pour comprendre une erreur de saisie.
   *
   * @returns la tâche créée, ou un refus explicite
   */
  create(input: {
    objective: string
    agentId: string
    context: string | null
    projectDir: string | null
    requestedLimits?: RequestedLimits | undefined
    durationS: number
    needsApproval: boolean
  }): { task: Task } | Refusal {
    const agent = this.store.getAgent(input.agentId)
    if (!agent) {
      return {
        error: 'agent_not_found',
        status: 404,
        detail: { agent_id: input.agentId, available: this.store.listAgents().map((a) => a.id) },
      }
    }
    if (!agent.enabled) {
      return {
        error: 'agent_disabled',
        status: 409,
        detail: { agent_id: agent.id, reason: this.whyDisabled(agent) },
      }
    }
    if (!this.engines.has(agent.kind)) {
      return { error: 'engine_unavailable', status: 503, detail: { agent_id: agent.id, kind: agent.kind } }
    }

    // Les limites du profil sont un **plafond** : la délégation ne peut que les
    // abaisser. Sans cette règle, Claude fixerait lui-même son budget, et le
    // budget ne protégerait plus personne.
    const limits = tightenLimits(agent.limits, input.requestedLimits ?? {})
    const { task } = this.bus.createTask({
      objective: input.objective,
      agentId: agent.id,
      context: input.context,
      // Une tâche simulée ne lit rien : lui attribuer une racine laisserait
      // croire qu'elle y touche.
      projectDir: agent.kind === 'simulated' ? null : input.projectDir,
      limits,
      durationS: input.durationS,
      // `steps_total` est le dénominateur affiché par MCP, la CLI et le
      // dashboard. L'exécutant simulé a ses propres étapes, comptées d'avance ;
      // un agent réel, lui, est borné par `max_steps`. Leur donner à tous la
      // constante du simulé affichait « 6/5 » pour une tâche plafonnée à 6, et
      // « 2/5 » pour une plafonnée à 12 : le seul chiffre qu'on consulte pour
      // savoir si une tâche a touché son plafond était faux.
      stepsTotal: agent.kind === 'simulated' ? STEPS_TOTAL : limits.max_steps,
      needsApproval: input.needsApproval,
    })
    this.log(`tâche ${short(task.id)} créée pour ${agent.id} (budget ${limits.max_cost_usd} $)`)
    this.engines.get(agent.kind)!.start(task, agent)
    return { task }
  }

  /** Pourquoi un profil est désactivé, en une phrase destinée à l'utilisateur. */
  private whyDisabled(agent: Agent): string {
    if (agent.provider_id === null) {
      return 'aucun fournisseur de modèle n\'est configuré pour ce profil'
    }
    if (!this.store.getProvider(agent.provider_id)) {
      return `le fournisseur « ${agent.provider_id} » n'existe plus`
    }
    return 'profil désactivé'
  }

  /**
   * Met une tâche en pause et crée la demande d'approbation correspondante.
   * Appelé par les moteurs via {@link EngineContext.requestApproval}.
   */
  private openApproval(
    taskId: string,
    operation: string,
    detail: Record<string, unknown>,
    payload: Record<string, unknown> = {},
  ): Approval | null {
    const task = this.store.getTask(taskId)
    if (!task || isTerminal(task.status) || task.status === 'waiting_approval') return null
    const seq = task.approval_seq + 1
    const approval = this.store.createApproval({
      taskId: task.id,
      seq,
      operation,
      operationDetail: detail,
      // L'empreinte lie la décision à cette opération précise, sous sa forme
      // structurée : le texte peut afficher pareil deux opérations différentes,
      // le détail canonique non.
      operationHash: operationHash(task.id, seq, detail),
      ttlMs: this.config.approvalTtlMs,
    })
    this.bus.record(
      task.id,
      'waiting_approval',
      {
        type: 'approval.requested',
        payload: { ...payload, approval_id: approval.id, operation, operation_hash: approval.operation_hash },
      },
      { approval_seq: seq, ...(typeof payload.step === 'number' ? { step: payload.step } : {}) },
    )
    this.bus.emitApproval(approval)
    this.log(`tâche ${short(task.id)} en attente d'approbation (${approval.id})`)
    return approval
  }

  // --- Décisions humaines --------------------------------------------------

  /**
   * Approuve une demande et relance la tâche.
   *
   * @param approvalId identifiant de la demande (pas de la tâche : une décision
   *                   porte sur une opération précise, pas sur « la tâche »)
   * @param by         `cli` ou `dashboard` — jamais le modèle
   * @returns la vue de la tâche relancée, ou un refus
   */
  approve(approvalId: string, by: string): TaskView | Refusal {
    const approval = this.store.getApproval(approvalId)
    if (!approval) return { error: 'approval_not_found', status: 404 }
    // La condition « encore en attente » est dans la requête SQL : deux décisions
    // simultanées ne peuvent pas aboutir toutes les deux.
    const resolved = this.store.resolveApproval(approvalId, 'approved', by)
    if (!resolved) return { error: 'approval_already_resolved', status: 409, detail: { status: approval.status } }
    this.bus.emitApproval(resolved)

    const task = this.store.getTask(resolved.task_id)
    if (!task || task.status !== 'waiting_approval') {
      return { error: 'task_not_waiting_approval', status: 409, detail: { status: task?.status ?? 'unknown' } }
    }
    const done = this.bus.record(
      task.id,
      'running',
      { type: 'approval.resolved', payload: { approval_id: approvalId, decision: 'approved', by } },
      { needs_approval: false },
    )!
    this.log(`approbation ${approvalId} accordée par ${by}, tâche ${short(task.id)} relancée`)
    const agent = this.store.getAgent(done.task.agent_id)
    const engine = agent ? this.engines.get(agent.kind) : undefined
    if (agent && engine) engine.resume(done.task, agent)
    return this.view(done.task)
  }

  /** Refuse une demande : la tâche s'arrête en `cancelled`, avec le motif. */
  reject(approvalId: string, by: string, reason?: string): TaskView | Refusal {
    const approval = this.store.getApproval(approvalId)
    if (!approval) return { error: 'approval_not_found', status: 404 }
    const resolved = this.store.resolveApproval(approvalId, 'rejected', by, reason)
    if (!resolved) return { error: 'approval_already_resolved', status: 409, detail: { status: approval.status } }
    this.bus.emitApproval(resolved)

    const task = this.store.getTask(resolved.task_id)
    if (!task || task.status !== 'waiting_approval') {
      return { error: 'task_not_waiting_approval', status: 409, detail: { status: task?.status ?? 'unknown' } }
    }
    const done = this.bus.record(
      task.id,
      'cancelled',
      { type: 'approval.resolved', payload: { approval_id: approvalId, decision: 'rejected', by, reason } },
      { needs_approval: false, error: reason ? `approbation refusée : ${reason}` : 'approbation refusée' },
    )!
    this.log(`approbation ${approvalId} refusée par ${by}`)
    const agent = this.store.getAgent(done.task.agent_id)
    const engine = agent ? this.engines.get(agent.kind) : undefined
    engine?.cancel(done.task)
    return this.view(done.task)
  }

  /**
   * Annule une tâche.
   *
   * Une tâche en pause d'approbation s'arrête tout de suite : elle n'exécute
   * rien, il n'y a aucun point de contrôle à attendre. Une tâche en marche passe
   * par `cancel_requested` et s'arrête quand son moteur atteint un point de
   * contrôle — forme coopérative qu'exigent les agents réels, qu'on ne peut pas
   * interrompre au milieu d'un appel de modèle sans en perdre le coût déjà payé.
   */
  cancel(taskId: string, reason?: string): TaskView | Refusal {
    const task = this.store.getTask(taskId)
    if (!task) return { error: 'task_not_found', status: 404 }
    if (isTerminal(task.status)) return { error: 'already_terminal', status: 409, detail: { status: task.status } }
    if (task.status === 'cancel_requested') {
      return { error: 'cancel_already_requested', status: 409, detail: { status: task.status } }
    }

    const pending = this.store.pendingApprovalFor(taskId)
    if (pending) {
      const resolved = this.store.resolveApproval(pending.id, 'rejected', 'cancel', 'tâche annulée avant décision')
      if (resolved) this.bus.emitApproval(resolved)
    }

    const agent = this.store.getAgent(task.agent_id)
    const engine = agent ? this.engines.get(agent.kind) : undefined

    if (task.status === 'waiting_approval') {
      engine?.cancel(task)
      const done = this.bus.record(
        taskId,
        'cancelled',
        { type: 'task.cancelled', payload: { reason, from: task.status } },
        { error: reason ?? 'annulée pendant une pause d\'approbation' },
      )!
      this.log(`tâche ${short(taskId)} annulée (en pause)`)
      return this.view(done.task)
    }

    const requested = this.bus.record(taskId, 'cancel_requested', {
      type: 'task.cancelled',
      payload: { reason, phase: 'requested' },
    })!
    // Le moteur dit s'il s'est arrêté net ou s'il s'arrêtera à son prochain
    // point de contrôle. Dans le second cas la tâche reste `cancel_requested`,
    // et c'est exact : elle n'est pas encore arrêtée.
    const stoppedNow = engine ? engine.cancel(requested.task) : true
    const done = (stoppedNow ? this.finishCancellation(taskId, reason) : null) ?? requested
    this.log(`tâche ${short(taskId)} annulation ${stoppedNow ? 'effective' : 'demandée'}`)
    return this.view(done.task)
  }

  /** Conclut une annulation demandée. @returns `null` si la tâche a fini entre-temps */
  private finishCancellation(taskId: string, reason?: string) {
    const task = this.store.getTask(taskId)
    if (!task || task.status !== 'cancel_requested') return null
    return this.bus.record(
      taskId,
      'cancelled',
      { type: 'task.cancelled', payload: { reason, phase: 'done' } },
      { error: reason ?? 'annulée à la demande de l\'utilisateur' },
    )
  }

  /**
   * Fait expirer les approbations dont le délai est écoulé, et arrête les tâches
   * correspondantes en `timed_out`.
   *
   * Sans cela, une tâche oubliée resterait en pause indéfiniment — et en Slice 3
   * elle retiendrait un worktree. Le statut est `timed_out` et non `failed` :
   * rien n'a échoué, c'est le délai de décision qui s'est écoulé, et le message
   * d'erreur le dit.
   */
  private expireDueApprovals(): void {
    for (const due of this.store.dueApprovals()) {
      const resolved = this.store.resolveApproval(due.id, 'expired', 'daemon', 'délai de décision écoulé')
      if (!resolved) continue
      this.bus.emitApproval(resolved)
      const task = this.store.getTask(due.task_id)
      if (!task || task.status !== 'waiting_approval') continue
      const agent = this.store.getAgent(task.agent_id)
      if (agent) this.engines.get(agent.kind)?.cancel(task)
      this.bus.record(
        task.id,
        'timed_out',
        { type: 'approval.resolved', payload: { approval_id: due.id, decision: 'expired' } },
        { needs_approval: false, error: `aucune décision humaine en ${humanDelay(this.config.approvalTtlMs)}` },
      )
      this.log(`approbation ${due.id} expirée, tâche ${short(task.id)} → timed_out`)
    }
  }

  // --- Lecture et attente --------------------------------------------------

  /** Compose la vue d'une tâche : état, consigne, approbation en cours. */
  view(task: Task): TaskView {
    return {
      task,
      next_action: nextActionFor(task),
      approval: task.status === 'waiting_approval' ? this.store.pendingApprovalFor(task.id) : null,
    }
  }

  /** Vue d'une tâche par identifiant. @returns `null` si elle n'existe pas */
  viewOf(taskId: string): TaskView | null {
    const task = this.store.getTask(taskId)
    return task ? this.view(task) : null
  }

  /** Timeline complète d'une tâche. */
  events(taskId: string): TaskEvent[] {
    return this.store.taskEvents(taskId)
  }

  /** Appels d'outils d'une tâche, dans l'ordre. Vide pour une tâche simulée. */
  toolCalls(taskId: string): ToolCall[] {
    return this.store.toolCalls(taskId)
  }

  /**
   * Attend qu'une tâche atteigne un état « actionnable » pour Claude : une fin,
   * ou une pause d'approbation **plus récente** que `knownApproval`.
   *
   * @param timeoutMs      délai maximal ; à l'expiration, l'état courant est rendu
   * @param knownApproval  numéro de la dernière pause déjà signalée à ce client
   * @param signal         annulation : le client a abandonné son attente
   * @returns la vue finale et le temps réellement attendu, ou `null` si la tâche
   *          n'existe pas
   */
  async wait(
    taskId: string,
    timeoutMs: number,
    knownApproval: number,
    signal?: AbortSignal,
  ): Promise<(TaskView & { waited_ms: number }) | null> {
    const started = Date.now()
    const current = this.store.getTask(taskId)
    if (!current) return null
    if (isActionable(current, knownApproval)) return { ...this.view(current), waited_ms: 0 }

    const task = await new Promise<Task>((resolve) => {
      let settled = false
      const finish = (t: Task) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        unsubscribe()
        signal?.removeEventListener('abort', onAbort)
        resolve(t)
      }
      const unsubscribe = this.bus.subscribe(({ task: changed }) => {
        if (changed.id === taskId && isActionable(changed, knownApproval)) finish(changed)
      })
      const onAbort = () => finish(this.store.getTask(taskId) ?? current)
      const timer = setTimeout(() => finish(this.store.getTask(taskId) ?? current), timeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      // Relecture après abonnement : une transition survenue entre la première
      // lecture et l'abonnement serait sinon manquée, et l'attente irait au bout
      // de son délai pour rien.
      const after = this.store.getTask(taskId)
      if (after && isActionable(after, knownApproval)) finish(after)
    })

    return { ...this.view(task), waited_ms: Date.now() - started }
  }
}

/** Identifiant du profil simulé, réexporté pour les appelants du daemon. */
export { SIMULATED_AGENT_ID }

/**
 * Délai en texte lisible. En minutes au-delà d'une minute, en secondes en deçà :
 * un délai de test réduit à deux secondes ne doit pas s'afficher « 0 minutes ».
 */
function humanDelay(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)} secondes` : `${Math.round(ms / 60_000)} minutes`
}

/** Identifiant abrégé pour les journaux : lisible sans être ambigu en pratique. */
function short(id: string): string {
  return id.slice(0, 8)
}
