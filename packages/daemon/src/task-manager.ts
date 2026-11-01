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
 *
 * Depuis la Slice 5, il porte aussi la **délégation** d'un orchestrateur : le
 * port qu'il lui remet ({@link TaskManager.delegationFor}), les règles qui
 * rattachent une sous-tâche à son parent ({@link TaskManager.create}), et la
 * cascade qui ne laisse aucun orphelin.
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
import type { DelegableAgent, DelegationPort, DelegationRefusal, SubtaskState, WaitStop } from '@midgaard/tools'
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
    // Aucun orphelin (Slice 5, décision 5) : une tâche qu'on annule, ou qui se
    // termine pour quelque raison que ce soit, emporte ses sous-tâches actives.
    // Écouter le bus plutôt que chaque chemin de fin : il y en a une dizaine
    // (moteurs, refus, expiration, annulation), et le bus les voit tous.
    this.bus.subscribe(({ task }) => {
      if (task.status !== 'cancel_requested' && !isTerminal(task.status)) return
      // Différé : le bus diffuse de façon synchrone, et annuler ici écrirait
      // les événements des enfants **pendant** la diffusion de celui du parent.
      // Les abonnés suivants — la WebSocket — recevraient alors des `seq` dans
      // le désordre, et un dashboard qui retient le dernier vu le perdrait.
      queueMicrotask(() => this.cancelChildren(task.id, task.status))
    })
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
      delegationFor: (parentTaskId, redact) => this.delegationFor(parentTaskId, redact),
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
   * **Une sous-tâche** (`parentTaskId`, posé par {@link delegationFor} et par
   * lui seul — jamais par une route HTTP) obéit à quatre règles de plus, ici
   * plutôt que dans l'outil pour qu'il n'en existe qu'une copie :
   *
   *  - son parent existe et est **encore actif** — ni fini, ni en cours
   *    d'annulation : un orchestrateur qui s'arrête ne lance plus rien ;
   *  - son parent est un **orchestrateur** ;
   *  - elle-même **n'en est pas un** : profondeur 1, pas d'arbre qui s'emballe
   *    (Slice 5, décision 1) ;
   *  - elle travaille sur le **dossier du parent**, jamais sur celui qu'on lui
   *    passerait (décision 9) : le modèle ne choisit pas où lit son enfant.
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
    parentTaskId?: string | null | undefined
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
    let projectDir = input.projectDir
    if (input.parentTaskId) {
      const parent = this.store.getTask(input.parentTaskId)
      if (!parent) return { error: 'parent_not_found', status: 404, detail: { parent_task_id: input.parentTaskId } }
      if (isTerminal(parent.status) || parent.status === 'cancel_requested') {
        return { error: 'parent_not_active', status: 409, detail: { parent_task_id: parent.id, status: parent.status } }
      }
      if (this.store.getAgent(parent.agent_id)?.kind !== 'orchestrator') {
        return { error: 'parent_cannot_delegate', status: 409, detail: { parent_task_id: parent.id } }
      }
      if (agent.kind === 'orchestrator') {
        return { error: 'nested_orchestrator', status: 409, detail: { agent_id: agent.id } }
      }
      projectDir = parent.project_dir
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
      projectDir: agent.kind === 'simulated' ? null : projectDir,
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
      parentTaskId: input.parentTaskId ?? null,
    })
    this.log(
      `tâche ${short(task.id)} créée pour ${agent.id} (budget ${limits.max_cost_usd} $)` +
        (input.parentTaskId ? `, sous-tâche de ${short(input.parentTaskId)}` : ''),
    )
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
    // Le motif de la demande, quand c'est le moteur qui conclut à son point de
    // contrôle : sans lui, une sous-tâche emportée par la cascade se dirait
    // annulée « à la demande de l'utilisateur ».
    const why = reason ?? this.store.cancelRequestReason(taskId) ?? undefined
    return this.bus.record(
      taskId,
      'cancelled',
      { type: 'task.cancelled', payload: { reason: why, phase: 'done' } },
      { error: why ?? 'annulée à la demande de l\'utilisateur' },
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

  // --- Délégation (Slice 5) -------------------------------------------------

  /**
   * Le port de délégation d'une tâche `orchestrator`.
   *
   * Lié à **sa** tâche : il ne voit, n'attend et n'annule que les sous-tâches
   * dont `parent_task_id` est elle, et c'est lui qui pose ce champ. Ce qu'il
   * rend est lu par le modèle : en anglais.
   *
   * @param redact expurgation de la tâche parente. L'objectif, le contexte et
   *               le motif d'annulation sont **écrits par un modèle** qui a pu
   *               lire une clé dans le projet, puis persistés : ils passent par
   *               elle, comme tout ce que la boucle journalise (PLAN §8.4, X1).
   */
  delegationFor(parentId: string, redact: (text: string) => string): DelegationPort {
    /** La sous-tâche, si elle appartient bien à ce parent. */
    const own = (taskId: string): Task | DelegationRefusal => {
      const task = this.store.getTask(taskId)
      // Même réponse pour une tâche inconnue et pour celle d'un autre arbre :
      // un orchestrateur n'a pas à apprendre ce qui existe hors du sien.
      if (!task || task.parent_task_id !== parentId) return { refused: `no subtask ${taskId} belongs to your task` }
      return task
    }

    return {
      listAgents: () =>
        this.store
          .listAgents()
          .filter((a) => a.kind !== 'orchestrator')
          .map(
            (a): DelegableAgent => ({
              id: a.id,
              name: a.name,
              kind: a.kind,
              description: a.description,
              enabled: a.enabled,
              disabled_reason: a.enabled ? null : this.whyDisabledForModel(a),
              limits: a.limits,
            }),
          ),

      delegate: (request) => {
        const created = this.create({
          objective: redact(request.objective.trim()),
          agentId: request.agent_id,
          context: request.context === undefined ? null : redact(request.context),
          // Ignoré : `create` impose le dossier du parent à une sous-tâche.
          projectDir: null,
          requestedLimits: request.limits,
          durationS: 20,
          needsApproval: false,
          parentTaskId: parentId,
        })
        if ('error' in created) return { refused: this.refusalForModel(created) }
        return subtaskState(created.task)
      },

      wait: async (taskId, options) => {
        const child = own(taskId)
        if ('refused' in child) return child
        const started = Date.now()
        if (!isTerminal(child.status)) {
          // Le statut du parent ne change pas (`running`) : sans cet événement,
          // le dashboard montrerait un orchestrateur immobile sans dire qui il
          // attend (décision 3).
          const parent = this.store.getTask(parentId)
          if (parent && !isTerminal(parent.status)) {
            this.bus.record(parentId, null, {
              type: 'subtask.waiting',
              payload: { task_id: child.id, agent_id: child.agent_id, status: child.status },
            })
          }
        }
        const stopped = await this.waitForEnd(taskId, options.signal, options.deadline)
        return { ...subtaskState(this.store.getTask(taskId)!), waited_ms: Date.now() - started, stopped_by: stopped }
      },

      cancel: (taskId, reason) => {
        const child = own(taskId)
        if ('refused' in child) return child
        if (isTerminal(child.status)) return { refused: `subtask ${taskId} already ended (${child.status})` }
        if (child.status === 'cancel_requested') return subtaskState(child)
        const done = this.cancel(
          taskId,
          reason ? `annulée par l'orchestrateur : ${redact(reason)}` : 'annulée par l\'orchestrateur',
        )
        if ('error' in done) return { refused: this.refusalForModel(done) }
        return subtaskState(done.task)
      },
    }
  }

  /**
   * Attend qu'une tâche atteigne un statut final.
   *
   * **Une pause d'approbation n'interrompt pas l'attente** (décision 2) :
   * l'orchestrateur n'a aucun moyen d'approuver, et lui rendre la main ne
   * servirait qu'à lui faire payer une étape pour rappeler l'attente. Pas de
   * tranches non plus — la coupure à 60 s est propre aux clients MCP.
   *
   * @param signal   arrêt de la tâche parente
   * @param deadline échéance de la tâche parente, en millisecondes depuis l'époque
   */
  private waitForEnd(taskId: string, signal?: AbortSignal, deadline?: number): Promise<WaitStop> {
    return new Promise<WaitStop>((resolve) => {
      let settled = false
      let timer: NodeJS.Timeout | undefined
      const finish = (why: WaitStop) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        unsubscribe()
        signal?.removeEventListener('abort', onAbort)
        resolve(why)
      }
      const unsubscribe = this.bus.subscribe(({ task }) => {
        if (task.id === taskId && isTerminal(task.status)) finish('ended')
      })
      const onAbort = () => finish('parent_stopping')
      signal?.addEventListener('abort', onAbort, { once: true })
      if (deadline !== undefined) timer = setTimeout(() => finish('deadline'), Math.max(0, deadline - Date.now()))
      // Relecture après abonnement, comme pour `wait` : une fin survenue entre
      // la lecture de l'appelant et l'abonnement serait sinon manquée.
      const now = this.store.getTask(taskId)
      if (!now || isTerminal(now.status)) finish('ended')
      else if (signal?.aborted) finish('parent_stopping')
    })
  }

  /**
   * Annule les sous-tâches actives d'une tâche qui s'arrête.
   *
   * Une sous-tâche déjà en `cancel_requested` est laissée à son moteur : la
   * redemander serait un refus (`cancel_already_requested`), pas une action.
   */
  private cancelChildren(parentId: string, parentStatus: Task['status']): void {
    for (const child of this.store.childTasks(parentId, { active: true })) {
      if (child.status === 'cancel_requested') continue
      const reason =
        parentStatus === 'cancel_requested' || parentStatus === 'cancelled'
          ? 'tâche parente annulée'
          : `tâche parente terminée (${parentStatus}) : sous-tâche annulée`
      const done = this.cancel(child.id, reason)
      this.log(
        `sous-tâche ${short(child.id)} de ${short(parentId)} : ` +
          ('error' in done ? `annulation impossible (${done.error})` : `annulation ${done.task.status}`),
      )
    }
  }

  /** Pourquoi un profil est désactivé, en anglais : c'est l'orchestrateur qui le lit. */
  private whyDisabledForModel(agent: Agent): string {
    if (agent.provider_id === null) return 'no model provider is configured for this profile'
    if (!this.store.getProvider(agent.provider_id)) return `its provider "${agent.provider_id}" no longer exists`
    return 'the profile is disabled'
  }

  /** Traduit un refus du gérant en phrase pour le modèle : ce qui bloque, et quoi faire. */
  private refusalForModel(refusal: Refusal): string {
    const d = refusal.detail ?? {}
    switch (refusal.error) {
      case 'agent_not_found':
        return `unknown profile "${String(d.agent_id)}": call list_agents to see the available ones`
      case 'agent_disabled': {
        const agent = this.store.getAgent(String(d.agent_id))
        return `profile "${String(d.agent_id)}" is disabled: ${agent ? this.whyDisabledForModel(agent) : 'unknown reason'}`
      }
      case 'nested_orchestrator':
        return 'you cannot delegate to an orchestrator profile: delegate to an executor instead'
      case 'parent_not_active':
        return 'your task is stopping: no new subtask can start'
      case 'engine_unavailable':
        return `profile "${String(d.agent_id)}" cannot run tasks in this version of the harness`
      default:
        return `refused by the harness (${refusal.error})`
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

/** Ce qu'une sous-tâche montre à son orchestrateur. */
function subtaskState(task: Task): SubtaskState {
  return {
    task_id: task.id,
    agent_id: task.agent_id,
    status: task.status,
    ended: isTerminal(task.status),
    result: task.result,
    error: task.error,
    usage: task.usage,
    limits: task.limits,
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
