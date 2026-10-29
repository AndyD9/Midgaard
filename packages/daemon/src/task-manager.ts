/**
 * @file Moteur de tâches : la machine à états en marche.
 *
 * En Slice 1, les tâches sont **simulées** — des étapes minutées, avec une pause
 * d'approbation facultative. On valide la machine à états, la persistance, le
 * journal, l'attente bloquante et les approbations ; les vrais agents arrivent en
 * Slice 2 et remplaceront `tick()` sans toucher au reste.
 *
 * Déroulé d'une tâche de `duration_s` secondes :
 *
 * ```text
 *  t=0        queued      création
 *  t≈0        preparing   task.started
 *  t=1·D/5    running     étape 1
 *  …
 *  t=3·D/5    running     étape 3 — ou waiting_approval si needs_approval
 *  …
 *  t=5·D/5    completed   résultat
 * ```
 *
 * Toutes les écritures passent par le bus ({@link EventBus}), jamais par le dépôt
 * directement : c'est ce qui garantit qu'aucun changement d'état n'échappe aux
 * long-polls ni aux dashboards connectés.
 */
import { createHash } from 'node:crypto'
import type { Approval, HarnessConfig, Task, TaskEvent } from '@midgaard/contracts'
import { isActionable, isTerminal, nextActionFor } from '@midgaard/contracts'
import type { HarnessStore } from '@midgaard/persistence'
import type { EventBus } from './bus.ts'

/** Nombre d'étapes d'une tâche simulée. */
export const STEPS_TOTAL = 5
/** Étape à laquelle une tâche `needs_approval` se met en pause. */
export const APPROVAL_STEP = 3
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

/** Pilote les tâches simulées et applique la machine à états. */
export class TaskManager {
  private readonly config: HarnessConfig
  private readonly store: HarnessStore
  private readonly bus: EventBus
  private readonly log: (...a: unknown[]) => void
  /** Minuteur de la prochaine étape, par tâche. Vit dans ce processus seulement. */
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private sweeper: NodeJS.Timeout | null = null

  constructor(config: HarnessConfig, store: HarnessStore, bus: EventBus, log: (...a: unknown[]) => void) {
    this.config = config
    this.store = store
    this.bus = bus
    this.log = log
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
    const sweepMs = Math.min(MAX_EXPIRY_SWEEP_MS, Math.max(500, Math.round(this.config.approvalTtlMs / 2)))
    this.sweeper = setInterval(() => this.expireDueApprovals(), sweepMs)
    this.sweeper.unref()
    return interrupted.length
  }

  /** Arrête tous les minuteurs. L'état reste en base ; les tâches actives seront
   * marquées `interrupted` au prochain démarrage. */
  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    if (this.sweeper) clearInterval(this.sweeper)
  }

  // --- Cycle de vie --------------------------------------------------------

  /** Crée une tâche et programme son démarrage. */
  create(input: { objective: string; durationS: number; needsApproval: boolean }): Task {
    const { task } = this.bus.createTask({
      objective: input.objective,
      durationS: input.durationS,
      stepsTotal: STEPS_TOTAL,
      needsApproval: input.needsApproval,
    })
    this.log(`tâche ${short(task.id)} créée (${input.durationS}s, approbation=${input.needsApproval})`)
    // Démarrage au tour de boucle suivant : la réponse HTTP de création part
    // avant, donc l'appelant reçoit bien `queued` puis observe la suite.
    this.schedule(task.id, 1)
    return task
  }

  /** Durée d'une étape pour cette tâche, en millisecondes. */
  private stepMs(task: Task): number {
    return Math.max(1, Math.round((task.duration_s * 1000) / task.steps_total))
  }

  private schedule(taskId: string, delayMs: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(taskId)
      try {
        this.tick(taskId)
      } catch (e) {
        this.log(`erreur sur la tâche ${short(taskId)} :`, e)
        this.bus.record(taskId, 'failed', { type: 'task.failed' }, { error: (e as Error).message })
      }
    }, delayMs)
    this.timers.set(taskId, timer)
  }

  /**
   * Fait avancer une tâche simulée d'une étape.
   *
   * Reprend l'état depuis la base à chaque fois plutôt que de le garder en
   * mémoire : une annulation ou une approbation a pu survenir entre la
   * programmation du minuteur et son déclenchement, et la base est la seule
   * source de vérité.
   */
  private tick(taskId: string): void {
    const task = this.store.getTask(taskId)
    if (!task) return
    // Garde-fou : une annulation a pu arriver entre la programmation et l'exécution.
    if (isTerminal(task.status) || task.status === 'waiting_approval') return

    if (task.status === 'queued') {
      this.bus.record(taskId, 'preparing', {
        type: 'task.started',
        payload: { message: 'préparation de l\'exécutant (tâche simulée : aucun agent réel en Slice 1)' },
      })
      this.schedule(taskId, this.stepMs(task))
      return
    }

    const step = task.step + 1

    if (step >= task.steps_total) {
      const result = {
        summary: `Tâche simulée terminée : ${task.objective}`,
        steps: Array.from({ length: task.steps_total }, (_, i) => `étape simulée ${i + 1}/${task.steps_total}`),
      }
      // `cancel_requested → completed` est légal : une tâche peut franchir sa
      // dernière étape avant d'avoir pris connaissance de l'annulation.
      this.bus.record(taskId, 'completed', { type: 'task.completed', payload: { result } }, { step, result })
      this.log(`tâche ${short(taskId)} terminée`)
      return
    }

    if (task.needs_approval && step === APPROVAL_STEP) {
      this.pauseForApproval(task, step)
      return
    }

    this.bus.record(
      taskId,
      task.status === 'cancel_requested' ? null : 'running',
      { type: 'task.progress', payload: { step, steps_total: task.steps_total } },
      { step },
    )
    // Une annulation demandée pendant l'étape précédente est honorée ici : la
    // tâche s'arrête au premier point de contrôle, sans tuer quoi que ce soit.
    if (task.status === 'cancel_requested') {
      this.finishCancellation(taskId)
      return
    }
    this.schedule(taskId, this.stepMs(task))
  }

  /** Met la tâche en pause et crée la demande d'approbation correspondante. */
  private pauseForApproval(task: Task, step: number): void {
    const seq = task.approval_seq + 1
    const operation = `étape ${step}/${task.steps_total} de « ${task.objective} »`
    const approval = this.store.createApproval({
      taskId: task.id,
      seq,
      operation,
      // L'empreinte lie la décision à cette opération précise : si l'opération
      // change, l'approbation ne s'y applique plus. En Slice 3 elle couvrira la
      // commande, ses arguments et le chemin visé.
      operationHash: createHash('sha256').update(`${task.id}\u0000${seq}\u0000${operation}`).digest('hex'),
      ttlMs: this.config.approvalTtlMs,
    })
    this.bus.record(
      task.id,
      'waiting_approval',
      { type: 'approval.requested', payload: { approval_id: approval.id, operation, step } },
      { step, approval_seq: seq },
    )
    this.bus.emitApproval(approval)
    this.log(`tâche ${short(task.id)} en attente d'approbation (${approval.id})`)
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
    this.schedule(task.id, this.stepMs(task))
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
    return this.view(done.task)
  }

  /**
   * Annule une tâche.
   *
   * Une tâche en pause d'approbation s'arrête tout de suite : elle n'exécute
   * rien, il n'y a aucun point de contrôle à attendre. Une tâche en marche passe
   * par `cancel_requested` et s'arrête à son étape suivante — c'est la forme
   * coopérative qu'exigeront les vrais agents, qu'on ne peut pas interrompre au
   * milieu d'un appel de modèle sans en perdre le coût.
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

    if (task.status === 'waiting_approval') {
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
    // Tâches simulées : le point de contrôle est immédiat. Avec de vrais agents,
    // on attendrait ici la fin de l'itération en cours.
    clearTimeout(this.timers.get(taskId))
    this.timers.delete(taskId)
    const done = this.finishCancellation(taskId, reason) ?? requested
    this.log(`tâche ${short(taskId)} annulée`)
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
