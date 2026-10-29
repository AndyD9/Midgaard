/**
 * @file `HarnessStore` : toute la mémoire longue du harness, derrière une API
 * où **un changement d'état et l'événement qui le raconte sont indissociables**.
 *
 * C'est l'invariant central de ce module : il n'existe aucune méthode publique
 * qui modifie une tâche sans écrire la ligne de journal correspondante, et les
 * deux écritures se font dans la même transaction. Sans cela, un crash entre les
 * deux laisserait soit une tâche dont l'historique ment, soit un historique qui
 * décrit un état que la tâche n'a jamais eu — et le dashboard, qui se reconstruit
 * à partir du journal, afficherait n'importe quoi.
 *
 * La base est ouverte en WAL : la CLI (`harness status`) lit pendant que le
 * daemon écrit, sans se bloquer mutuellement.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  ACTIVE_STATUSES,
  IllegalTransitionError,
  canTransition,
  isTerminal,
  type Approval,
  type ApprovalStatus,
  type EventType,
  type HarnessConfig,
  type Task,
  type TaskEvent,
  type TaskResult,
  type TaskStatus,
} from '@midgaard/contracts'
import { migrate } from './migrations.ts'

/** Ligne `tasks` telle que SQLite la rend. */
interface TaskRow {
  id: string
  objective: string
  status: string
  step: number
  steps_total: number
  needs_approval: number
  approval_seq: number
  duration_s: number
  created_at: string
  updated_at: string
  started_at: string | null
  ended_at: string | null
  result_json: string | null
  error: string | null
}

/** Ligne `task_events` telle que SQLite la rend. */
interface EventRow {
  seq: number
  task_id: string
  task_seq: number
  type: string
  status: string
  at: string
  payload_json: string
}

/** Champs d'une tâche qu'une transition peut mettre à jour au passage. */
export interface TaskPatch {
  step?: number
  needs_approval?: boolean
  approval_seq?: number
  started_at?: string | null
  ended_at?: string | null
  result?: TaskResult | null
  error?: string | null
}

/** Événement à écrire en même temps qu'un changement d'état. */
export interface EventInput {
  type: EventType
  payload?: Record<string, unknown>
}

/** Ce que rend toute opération d'écriture : l'état après coup, et son récit. */
export interface Recorded {
  task: Task
  event: TaskEvent
}

/**
 * Convertit les lignes rendues par `node:sqlite` dans la forme attendue.
 *
 * Le module type ses résultats en `Record<string, SQLOutputValue>`, puisqu'il ne
 * connaît pas le schéma. La conversion est donc inévitable ; elle est centralisée
 * dans ces deux fonctions, au contact immédiat des requêtes, plutôt que répétée
 * à chaque appel. Les formes `TaskRow` et `EventRow` ci-dessus sont la
 * description de ce que le schéma garantit.
 */
function rows<T>(values: unknown): T[] {
  return values as T[]
}

/** Variante pour une ligne unique ; `undefined` si la requête n'a rien rendu. */
function row<T>(value: unknown): T | undefined {
  return value as T | undefined
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    objective: row.objective,
    status: row.status as TaskStatus,
    step: row.step,
    steps_total: row.steps_total,
    needs_approval: row.needs_approval === 1,
    approval_seq: row.approval_seq,
    duration_s: row.duration_s,
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: row.started_at,
    ended_at: row.ended_at,
    result: row.result_json ? (JSON.parse(row.result_json) as TaskResult) : null,
    error: row.error,
  }
}

function toEvent(row: EventRow): TaskEvent {
  return {
    seq: row.seq,
    task_seq: row.task_seq,
    task_id: row.task_id,
    type: row.type as EventType,
    at: row.at,
    status: row.status as TaskStatus,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  }
}

/**
 * Dépôt unique du harness. Une instance par processus : `node:sqlite` est
 * synchrone et ne demande donc aucun pool de connexions.
 */
export class HarnessStore {
  readonly db: DatabaseSync

  private constructor(db: DatabaseSync) {
    this.db = db
  }

  /**
   * Ouvre (et crée au besoin) la base du harness, puis applique les migrations.
   *
   * @param config configuration injectée ; seul `dbPath` est utilisé
   * @param log    journalisation des migrations appliquées
   * @throws si la base vient d'une version plus récente du harness
   */
  static open(config: Pick<HarnessConfig, 'dbPath'>, log: (msg: string) => void = () => {}): HarnessStore {
    mkdirSync(dirname(config.dbPath), { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(config.dbPath)
    // WAL : lecteurs et écrivain ne se bloquent plus (la CLI lit pendant que le
    // daemon écrit). `busy_timeout` évite un `SQLITE_BUSY` immédiat sur la
    // fraction de seconde où un écrivain tient encore le verrou.
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA busy_timeout = 5000')
    migrate(db, log)
    return new HarnessStore(db)
  }

  close(): void {
    this.db.close()
  }

  /**
   * Exécute `fn` dans une transaction, en annulant tout si elle lève.
   * `BEGIN IMMEDIATE` prend le verrou d'écriture dès le début : une transaction
   * qui commence en lecture puis veut écrire peut échouer en WAL, ce qui ferait
   * perdre un événement déjà calculé.
   */
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (e) {
      try {
        this.db.exec('ROLLBACK')
      } catch {}
      throw e
    }
  }

  /** Écrit un événement et le relit tel que la base l'a numéroté. Doit tourner dans une transaction. */
  private insertEvent(taskId: string, status: TaskStatus, input: EventInput, at: string): TaskEvent {
    const next = row<{ n: number }>(
      this.db
        .prepare('SELECT COALESCE(MAX(task_seq), 0) + 1 AS n FROM task_events WHERE task_id = :id')
        .get({ id: taskId }),
    )!
    const info = this.db
      .prepare(
        `INSERT INTO task_events (task_id, task_seq, type, status, at, payload_json)
         VALUES (:task_id, :task_seq, :type, :status, :at, :payload)`,
      )
      .run({
        task_id: taskId,
        task_seq: next.n,
        type: input.type,
        status,
        at,
        payload: JSON.stringify(input.payload ?? {}),
      })
    return {
      seq: Number(info.lastInsertRowid),
      task_seq: next.n,
      task_id: taskId,
      type: input.type,
      at,
      status,
      payload: input.payload ?? {},
    }
  }

  // --- Tâches --------------------------------------------------------------

  /**
   * Crée une tâche en statut `queued` et son événement `task.created`.
   *
   * @returns la tâche créée et l'événement à diffuser
   */
  createTask(input: { objective: string; durationS: number; stepsTotal: number; needsApproval: boolean }): Recorded {
    const now = new Date().toISOString()
    const id = randomUUID()
    return this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO tasks (id, objective, status, step, steps_total, needs_approval, approval_seq,
                              duration_s, created_at, updated_at)
           VALUES (:id, :objective, 'queued', 0, :steps_total, :needs_approval, 0, :duration_s, :now, :now)`,
        )
        .run({
          id,
          objective: input.objective,
          steps_total: input.stepsTotal,
          needs_approval: input.needsApproval ? 1 : 0,
          duration_s: input.durationS,
          now,
        })
      const event = this.insertEvent(
        id,
        'queued',
        { type: 'task.created', payload: { objective: input.objective, duration_s: input.durationS } },
        now,
      )
      return { task: this.getTask(id)!, event }
    })
  }

  getTask(id: string): Task | null {
    const found = row<TaskRow>(this.db.prepare('SELECT * FROM tasks WHERE id = :id').get({ id }))
    return found ? toTask(found) : null
  }

  /**
   * Liste les tâches, de la plus récente à la plus ancienne.
   * @param filter `status` pour n'en garder qu'un, `active` pour tous les statuts non finaux
   */
  listTasks(filter: { status?: TaskStatus; active?: boolean; limit?: number } = {}): Task[] {
    const limit = filter.limit ?? 200
    if (filter.status) {
      return rows<TaskRow>(
        this.db
          .prepare('SELECT * FROM tasks WHERE status = :s ORDER BY created_at DESC LIMIT :l')
          .all({ s: filter.status, l: limit }),
      ).map(toTask)
    }
    if (filter.active) {
      const marks = ACTIVE_STATUSES.map((_, i) => `?${i + 1}`).join(', ')
      return rows<TaskRow>(
        this.db
          .prepare(`SELECT * FROM tasks WHERE status IN (${marks}) ORDER BY created_at DESC`)
          .all(...ACTIVE_STATUSES),
      ).map(toTask)
    }
    return rows<TaskRow>(
      this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT :l').all({ l: limit }),
    ).map(toTask)
  }

  /** Compte les tâches, au total et parmi les statuts actifs. */
  countTasks(): { total: number; active: number } {
    const marks = ACTIVE_STATUSES.map((_, i) => `?${i + 1}`).join(', ')
    const total = row<{ n: number }>(this.db.prepare('SELECT COUNT(*) AS n FROM tasks').get())!
    const active = row<{ n: number }>(
      this.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status IN (${marks})`).get(...ACTIVE_STATUSES),
    )!
    return { total: total.n, active: active.n }
  }

  /**
   * Fait passer une tâche d'un statut à un autre et écrit l'événement, dans la
   * même transaction.
   *
   * @param id    identifiant de la tâche
   * @param to    statut visé ; `null` pour journaliser sans changer de statut
   *              (progression d'étape, message d'agent)
   * @param event événement à écrire
   * @param patch champs à mettre à jour au passage
   * @returns `null` si la tâche n'existe pas
   * @throws {IllegalTransitionError} si la transition n'est pas dans la table des
   *         transitions légales. C'est un bug du daemon, pas une condition de
   *         course : mieux vaut un échec bruyant qu'un historique corrompu.
   */
  record(id: string, to: TaskStatus | null, event: EventInput, patch: TaskPatch = {}): Recorded | null {
    const now = new Date().toISOString()
    return this.tx(() => {
      const current = row<TaskRow>(this.db.prepare('SELECT * FROM tasks WHERE id = :id').get({ id }))
      if (!current) return null
      const from = current.status as TaskStatus
      const status = to ?? from
      if (to !== null && to !== from && !canTransition(from, to)) throw new IllegalTransitionError(id, from, to)

      const sets: string[] = ['status = :status', 'updated_at = :now']
      const params: Record<string, string | number | null> = { id, status, now }
      const assign = (column: string, value: string | number | null) => {
        sets.push(`${column} = :${column}`)
        params[column] = value
      }
      if (patch.step !== undefined) assign('step', patch.step)
      if (patch.needs_approval !== undefined) assign('needs_approval', patch.needs_approval ? 1 : 0)
      if (patch.approval_seq !== undefined) assign('approval_seq', patch.approval_seq)
      if (patch.started_at !== undefined) assign('started_at', patch.started_at)
      if (patch.error !== undefined) assign('error', patch.error)
      if (patch.result !== undefined) assign('result_json', patch.result ? JSON.stringify(patch.result) : null)
      // `ended_at` est posé d'office à l'entrée dans un statut final : c'est une
      // propriété du statut, pas quelque chose que chaque appelant doit penser à fournir.
      if (patch.ended_at !== undefined) assign('ended_at', patch.ended_at)
      else if (to !== null && isTerminal(to) && current.ended_at === null) assign('ended_at', now)

      this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = :id`).run(params)
      const written = this.insertEvent(id, status, event, now)
      return { task: this.getTask(id)!, event: written }
    })
  }

  /**
   * Marque `interrupted` toutes les tâches restées actives, à appeler au
   * démarrage du daemon.
   *
   * Le plan ne parlait que de `running` et `preparing` ; en pratique **tout**
   * statut actif doit l'être. Rien ne reprend une tâche : ses minuteurs vivaient
   * dans le processus précédent, une tâche `queued` ne démarrera jamais et une
   * tâche `waiting_approval` a perdu le contexte de sa pause. Les laisser
   * actives les ferait attendre indéfiniment une suite qui ne viendra pas.
   *
   * Une tâche interrompue n'est **jamais reprise ni considérée réussie**.
   *
   * @returns une entrée par tâche interrompue (vide au démarrage normal)
   */
  markInterrupted(): Recorded[] {
    const active = this.listTasks({ active: true })
    const out: Recorded[] = []
    for (const task of active) {
      const done = this.record(
        task.id,
        'interrupted',
        { type: 'task.interrupted', payload: { previous_status: task.status, step: task.step } },
        { error: `tâche interrompue par un redémarrage du daemon (statut précédent : ${task.status})` },
      )
      if (done) out.push(done)
    }
    return out
  }

  // --- Journal -------------------------------------------------------------

  /** Dernière séquence globale attribuée ; `0` si le journal est vide. */
  lastSeq(): number {
    return row<{ n: number }>(this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM task_events').get())!.n
  }

  /**
   * Événements d'après la séquence `since`, pour la reprise WebSocket.
   * @param limit borne de sécurité ; au-delà, l'appelant doit repartir du snapshot
   */
  eventsSince(since: number, limit: number): TaskEvent[] {
    return rows<EventRow>(
      this.db
        .prepare('SELECT * FROM task_events WHERE seq > :since ORDER BY seq ASC LIMIT :l')
        .all({ since, l: limit }),
    ).map(toEvent)
  }

  /** Timeline complète d'une tâche, dans l'ordre. */
  taskEvents(taskId: string): TaskEvent[] {
    return rows<EventRow>(
      this.db
        .prepare('SELECT * FROM task_events WHERE task_id = :id ORDER BY task_seq ASC')
        .all({ id: taskId }),
    ).map(toEvent)
  }

  // --- Approbations --------------------------------------------------------

  /** Crée une demande d'approbation en attente. */
  createApproval(input: {
    taskId: string
    seq: number
    operation: string
    operationHash: string
    ttlMs: number
  }): Approval {
    const now = new Date()
    const approval: Approval = {
      id: randomUUID(),
      task_id: input.taskId,
      seq: input.seq,
      operation: input.operation,
      operation_hash: input.operationHash,
      status: 'pending',
      requested_at: now.toISOString(),
      expires_at: new Date(now.getTime() + input.ttlMs).toISOString(),
      resolved_at: null,
      resolved_by: null,
      reason: null,
    }
    this.db
      .prepare(
        `INSERT INTO approvals (id, task_id, seq, operation, operation_hash, status, requested_at, expires_at)
         VALUES (:id, :task_id, :seq, :operation, :operation_hash, 'pending', :requested_at, :expires_at)`,
      )
      .run({
        id: approval.id,
        task_id: approval.task_id,
        seq: approval.seq,
        operation: approval.operation,
        operation_hash: approval.operation_hash,
        requested_at: approval.requested_at,
        expires_at: approval.expires_at,
      })
    return approval
  }

  /** Approbation en attente d'une tâche, s'il y en a une. */
  pendingApprovalFor(taskId: string): Approval | null {
    return (
      row<Approval>(
        this.db
          .prepare("SELECT * FROM approvals WHERE task_id = :id AND status = 'pending' ORDER BY seq DESC LIMIT 1")
          .get({ id: taskId }),
      ) ?? null
    )
  }

  /** Toutes les approbations en attente, de la plus ancienne à la plus récente. */
  pendingApprovals(): Approval[] {
    return rows<Approval>(
      this.db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY requested_at ASC").all(),
    )
  }

  getApproval(id: string): Approval | null {
    return row<Approval>(this.db.prepare('SELECT * FROM approvals WHERE id = :id').get({ id })) ?? null
  }

  /**
   * Clôt une approbation. **À usage unique** : la condition `status = 'pending'`
   * est dans la requête, donc deux décisions simultanées ne peuvent pas aboutir
   * toutes les deux.
   *
   * @returns l'approbation mise à jour, ou `null` si elle était déjà close
   */
  resolveApproval(id: string, status: Exclude<ApprovalStatus, 'pending'>, by: string, reason?: string): Approval | null {
    const info = this.db
      .prepare(
        `UPDATE approvals SET status = :status, resolved_at = :at, resolved_by = :by, reason = :reason
         WHERE id = :id AND status = 'pending'`,
      )
      .run({ id, status, at: new Date().toISOString(), by, reason: reason ?? null })
    return info.changes === 1 ? this.getApproval(id) : null
  }

  /** Approbations en attente dont le délai est écoulé. La décision de ce qu'on en fait appartient au daemon. */
  dueApprovals(now = new Date()): Approval[] {
    return rows<Approval>(
      this.db
        .prepare("SELECT * FROM approvals WHERE status = 'pending' AND expires_at <= :now")
        .all({ now: now.toISOString() }),
    )
  }
}
