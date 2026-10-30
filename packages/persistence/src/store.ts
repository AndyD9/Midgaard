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
  emptyUsage,
  isTerminal,
  type Agent,
  type AgentKind,
  type AgentLimits,
  type Approval,
  type ApprovalStatus,
  type ConnectionTest,
  type EventType,
  type HarnessConfig,
  type ProviderConfig,
  type ProviderKind,
  type ProviderPreset,
  type Task,
  type TaskEvent,
  type TaskResult,
  type TaskStatus,
  type ToolCall,
  type ToolCallStatus,
  type ToolDecision,
  type Usage,
  type ExecAllowEntry,
  type WebSearchMode,
  type Workspace,
  type WorkspaceStatus,
} from '@midgaard/contracts'
import { migrate, schemaVersionOf } from './migrations.ts'

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
  agent_id: string
  context: string | null
  limits_json: string
  usage_json: string
  project_dir: string | null
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
  /** Consommation cumulée, remplacée en bloc : c'est la boucle qui additionne, pas la base. */
  usage?: Usage
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
    // Un résultat écrit avant la Slice 3 n'a pas de `workspace` : on le lit
    // comme `null`, ce qu'il était, plutôt que de laisser circuler un champ absent.
    result: row.result_json ? withWorkspace(JSON.parse(row.result_json) as Partial<TaskResult>) : null,
    error: row.error,
    agent_id: row.agent_id,
    context: row.context,
    limits: JSON.parse(row.limits_json) as AgentLimits,
    usage: JSON.parse(row.usage_json) as Usage,
    project_dir: row.project_dir,
  }
}

/** Complète un résultat antérieur à la Slice 3, qui n'avait pas de `workspace`. */
function withWorkspace(result: Partial<TaskResult>): TaskResult {
  return { ...result, workspace: result.workspace ?? null } as TaskResult
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

  /**
   * Ouvre une base existante **en lecture seule**, sans la migrer.
   *
   * Pour qui constate sans agir : `harness doctor` et `harness status`. Un
   * diagnostic qui migre la base qu'il examine change ce qu'il rapporte — et
   * l'a fait, sous un daemon plus ancien encore en marche (docs/SLICE3.md,
   * leçon n° 17). Ici, c'est SQLite qui refuse toute écriture : une méthode
   * d'écriture appelée par erreur lève au lieu d'écrire.
   *
   * Aucun `PRAGMA journal_mode` : en changer est une écriture. Une base du
   * harness est déjà en WAL, mode que SQLite lit dans l'en-tête du fichier.
   * Lire une base WAL fait toutefois créer par SQLite ses fichiers `-wal` et
   * `-shm` s'ils manquent ; le fichier de la base, lui, reste octet pour octet
   * identique.
   *
   * L'appelant doit comparer {@link HarnessStore.schemaVersion} à
   * `SCHEMA_VERSION` avant de lire : sur un autre schéma, les requêtes de ce
   * code peuvent viser des tables ou des colonnes qui n'y sont pas.
   *
   * @param config configuration injectée ; seul `dbPath` est utilisé
   * @throws si la base n'existe pas — la lecture seule ne la crée jamais
   */
  static openReadOnly(config: Pick<HarnessConfig, 'dbPath'>): HarnessStore {
    const db = new DatabaseSync(config.dbPath, { readOnly: true })
    db.exec('PRAGMA busy_timeout = 5000')
    return new HarnessStore(db)
  }

  /** Version de schéma de la base ouverte (`0` pour une base vierge). */
  get schemaVersion(): number {
    return schemaVersionOf(this.db)
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
  createTask(input: {
    objective: string
    agentId: string
    context: string | null
    projectDir: string | null
    limits: AgentLimits
    durationS: number
    stepsTotal: number
    needsApproval: boolean
  }): Recorded {
    const now = new Date().toISOString()
    const id = randomUUID()
    return this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO tasks (id, objective, status, step, steps_total, needs_approval, approval_seq,
                              duration_s, created_at, updated_at, agent_id, context, limits_json, usage_json,
                              project_dir)
           VALUES (:id, :objective, 'queued', 0, :steps_total, :needs_approval, 0, :duration_s, :now, :now,
                   :agent_id, :context, :limits, :usage, :project_dir)`,
        )
        .run({
          id,
          objective: input.objective,
          steps_total: input.stepsTotal,
          needs_approval: input.needsApproval ? 1 : 0,
          duration_s: input.durationS,
          now,
          agent_id: input.agentId,
          context: input.context,
          project_dir: input.projectDir,
          limits: JSON.stringify(input.limits),
          usage: JSON.stringify(emptyUsage()),
        })
      const event = this.insertEvent(
        id,
        'queued',
        {
          type: 'task.created',
          payload: { objective: input.objective, agent_id: input.agentId, limits: input.limits },
        },
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
    return this.tx(() => this.recordUnlocked(id, to, event, patch))
  }

  /**
   * Corps de {@link HarnessStore.record}, **sans** transaction : à n'appeler que
   * depuis une transaction ouverte. C'est ce qui permet à une autre table — les
   * worktrees — d'écrire sa ligne et l'événement qui la raconte d'un seul bloc.
   */
  private recordUnlocked(id: string, to: TaskStatus | null, event: EventInput, patch: TaskPatch = {}): Recorded | null {
    const now = new Date().toISOString()
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
    if (patch.usage !== undefined) assign('usage_json', JSON.stringify(patch.usage))
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

  /**
   * Crée une demande d'approbation en attente.
   *
   * @param input.operationDetail forme structurée de l'opération, d'où
   *        `operationHash` a été tirée ; conservée pour qu'on puisse relire,
   *        après coup, ce qui a été autorisé au juste
   */
  createApproval(input: {
    taskId: string
    seq: number
    operation: string
    operationDetail: Record<string, unknown> | null
    operationHash: string
    ttlMs: number
  }): Approval {
    const now = new Date()
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO approvals (id, task_id, seq, operation, operation_json, operation_hash, status,
                                requested_at, expires_at)
         VALUES (:id, :task_id, :seq, :operation, :operation_json, :operation_hash, 'pending',
                 :requested_at, :expires_at)`,
      )
      .run({
        id,
        task_id: input.taskId,
        seq: input.seq,
        operation: input.operation,
        operation_json: input.operationDetail ? JSON.stringify(input.operationDetail) : null,
        operation_hash: input.operationHash,
        requested_at: now.toISOString(),
        expires_at: new Date(now.getTime() + input.ttlMs).toISOString(),
      })
    return this.getApproval(id)!
  }

  /** Approbation en attente d'une tâche, s'il y en a une. */
  pendingApprovalFor(taskId: string): Approval | null {
    return (
      toApprovalOrNull(
        this.db
          .prepare("SELECT * FROM approvals WHERE task_id = :id AND status = 'pending' ORDER BY seq DESC LIMIT 1")
          .get({ id: taskId }),
      )
    )
  }

  /** Toutes les approbations en attente, de la plus ancienne à la plus récente. */
  pendingApprovals(): Approval[] {
    return rows<ApprovalRow>(
      this.db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY requested_at ASC").all(),
    ).map(toApproval)
  }

  getApproval(id: string): Approval | null {
    return toApprovalOrNull(this.db.prepare('SELECT * FROM approvals WHERE id = :id').get({ id }))
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
    return rows<ApprovalRow>(
      this.db
        .prepare("SELECT * FROM approvals WHERE status = 'pending' AND expires_at <= :now")
        .all({ now: now.toISOString() }),
    ).map(toApproval)
  }

  // --- Fournisseurs --------------------------------------------------------

  /**
   * Déclare ou met à jour un fournisseur.
   *
   * **Ne reçoit jamais de clé d'API**, seulement la référence qui la désigne
   * dans le coffre. Le daemon dépose la clé avant d'appeler cette méthode ; si
   * l'ordre était inverse, un échec de coffre laisserait une configuration qui
   * promet une clé inexistante.
   *
   * Le `last_test` d'une configuration existante est **effacé** : changer
   * d'endpoint, de modèle ou de clé invalide le dernier test réussi, et
   * continuer à l'afficher ferait croire à une connexion vérifiée qui ne l'est
   * plus.
   */
  upsertProvider(input: {
    id: string
    name: string
    kind: ProviderKind
    preset: ProviderPreset
    baseUrl: string | null
    defaultModel: string
    secretRef: string | null
    webSearch: WebSearchMode
  }): ProviderConfig {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO provider_configs
           (id, name, kind, preset, base_url, default_model, secret_ref, web_search,
            created_at, updated_at, last_test_json)
         VALUES (:id, :name, :kind, :preset, :base_url, :default_model, :secret_ref, :web_search,
                 :now, :now, NULL)
         ON CONFLICT(id) DO UPDATE SET
           name = :name, kind = :kind, preset = :preset, base_url = :base_url,
           default_model = :default_model, secret_ref = :secret_ref, web_search = :web_search,
           updated_at = :now, last_test_json = NULL`,
      )
      .run({
        id: input.id,
        name: input.name,
        kind: input.kind,
        preset: input.preset,
        base_url: input.baseUrl,
        default_model: input.defaultModel,
        secret_ref: input.secretRef,
        web_search: input.webSearch,
        now,
      })
    return this.getProvider(input.id)!
  }

  getProvider(id: string): ProviderConfig | null {
    const found = row<ProviderRow>(this.db.prepare('SELECT * FROM provider_configs WHERE id = :id').get({ id }))
    return found ? toProvider(found) : null
  }

  /** Fournisseurs déclarés, dans l'ordre de déclaration. */
  listProviders(): ProviderConfig[] {
    return rows<ProviderRow>(
      this.db.prepare('SELECT * FROM provider_configs ORDER BY created_at ASC').all(),
    ).map(toProvider)
  }

  /** Enregistre le résultat d'un « Test connection ». @returns `null` si le fournisseur n'existe plus */
  recordProviderTest(id: string, test: ConnectionTest): ProviderConfig | null {
    const info = this.db
      .prepare('UPDATE provider_configs SET last_test_json = :t, updated_at = :now WHERE id = :id')
      .run({ id, t: JSON.stringify(test), now: new Date().toISOString() })
    return info.changes === 1 ? this.getProvider(id) : null
  }

  /**
   * Supprime un fournisseur. Les profils qui s'y référaient ne sont **pas**
   * supprimés : c'est au daemon de les désactiver, pour que l'utilisateur
   * retrouve sa configuration après avoir changé de clé.
   *
   * @returns vrai si quelque chose a été supprimé
   */
  deleteProvider(id: string): boolean {
    return this.db.prepare('DELETE FROM provider_configs WHERE id = :id').run({ id }).changes === 1
  }

  // --- Agents --------------------------------------------------------------

  /** Déclare ou met à jour un profil d'agent. */
  upsertAgent(input: {
    id: string
    name: string
    kind: AgentKind
    description: string
    providerId: string | null
    model: string | null
    systemPrompt: string
    tools: string[]
    limits: AgentLimits
    enabled: boolean
  }): Agent {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO agents
           (id, name, kind, description, provider_id, model, system_prompt, tools_json,
            limits_json, enabled, created_at, updated_at)
         VALUES (:id, :name, :kind, :description, :provider_id, :model, :system_prompt, :tools,
                 :limits, :enabled, :now, :now)
         ON CONFLICT(id) DO UPDATE SET
           name = :name, kind = :kind, description = :description, provider_id = :provider_id,
           model = :model, system_prompt = :system_prompt, tools_json = :tools,
           limits_json = :limits, enabled = :enabled, updated_at = :now`,
      )
      .run({
        id: input.id,
        name: input.name,
        kind: input.kind,
        description: input.description,
        provider_id: input.providerId,
        model: input.model,
        system_prompt: input.systemPrompt,
        tools: JSON.stringify(input.tools),
        limits: JSON.stringify(input.limits),
        enabled: input.enabled ? 1 : 0,
        now,
      })
    return this.getAgent(input.id)!
  }

  getAgent(id: string): Agent | null {
    const found = row<AgentRow>(this.db.prepare('SELECT * FROM agents WHERE id = :id').get({ id }))
    return found ? toAgent(found) : null
  }

  /** Profils déclarés, le simulé en premier puis par ordre de déclaration. */
  listAgents(): Agent[] {
    return rows<AgentRow>(this.db.prepare('SELECT * FROM agents ORDER BY created_at ASC').all()).map(toAgent)
  }

  /** Active ou désactive un profil. @returns le profil, ou `null` s'il n'existe pas */
  setAgentEnabled(id: string, enabled: boolean): Agent | null {
    const info = this.db
      .prepare('UPDATE agents SET enabled = :e, updated_at = :now WHERE id = :id')
      .run({ id, e: enabled ? 1 : 0, now: new Date().toISOString() })
    return info.changes === 1 ? this.getAgent(id) : null
  }

  /** Profils rattachés à un fournisseur donné, pour les désactiver quand il disparaît. */
  agentsUsingProvider(providerId: string): Agent[] {
    return rows<AgentRow>(
      this.db.prepare('SELECT * FROM agents WHERE provider_id = :p').all({ p: providerId }),
    ).map(toAgent)
  }

  // --- Appels d'outils -----------------------------------------------------

  /**
   * Journalise un appel d'outil demandé par le modèle.
   *
   * Écrit **avant** l'exécution, et non après : un outil qui part en boucle ou
   * ne rend jamais la main doit être visible dans le dashboard pendant qu'il
   * dure. Un journal qui n'enregistre que les fins ne montre jamais ce qui bloque.
   *
   * @param argumentsJson arguments **déjà expurgés** par l'appelant
   */
  createToolCall(input: {
    taskId: string
    step: number
    callId: string
    name: string
    decision: ToolDecision
    status: ToolCallStatus
    argumentsJson: string
  }): ToolCall {
    const id = randomUUID()
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO tool_calls (id, task_id, step, call_id, name, status, decision,
                                 arguments_json, requested_at)
         VALUES (:id, :task_id, :step, :call_id, :name, :status, :decision, :args, :now)`,
      )
      .run({
        id,
        task_id: input.taskId,
        step: input.step,
        call_id: input.callId,
        name: input.name,
        status: input.status,
        decision: input.decision,
        args: input.argumentsJson,
        now,
      })
    return this.getToolCall(id)!
  }

  getToolCall(id: string): ToolCall | null {
    const found = row<ToolCallRow>(this.db.prepare('SELECT * FROM tool_calls WHERE id = :id').get({ id }))
    return found ? toToolCall(found) : null
  }

  /**
   * Clôt un appel d'outil.
   * @param patch `summary` et `error` doivent être **expurgés** par l'appelant
   * @returns l'appel mis à jour, ou `null` s'il n'existe pas
   */
  finishToolCall(
    id: string,
    patch: {
      status: ToolCallStatus
      summary?: string | null
      bytes?: number | null
      durationMs?: number | null
      error?: string | null
    },
  ): ToolCall | null {
    const info = this.db
      .prepare(
        `UPDATE tool_calls
         SET status = :status, result_summary = :summary, result_bytes = :bytes,
             duration_ms = :duration, error = :error, ended_at = :now
         WHERE id = :id`,
      )
      .run({
        id,
        status: patch.status,
        summary: patch.summary ?? null,
        bytes: patch.bytes ?? null,
        duration: patch.durationMs ?? null,
        error: patch.error ?? null,
        now: new Date().toISOString(),
      })
    return info.changes === 1 ? this.getToolCall(id) : null
  }

  /** Appels d'outils d'une tâche, dans l'ordre où ils ont été demandés. */
  toolCalls(taskId: string): ToolCall[] {
    return rows<ToolCallRow>(
      this.db
        .prepare('SELECT * FROM tool_calls WHERE task_id = :id ORDER BY requested_at ASC, rowid ASC')
        .all({ id: taskId }),
    ).map(toToolCall)
  }

  // --- Espaces de travail --------------------------------------------------

  /**
   * Enregistre le worktree d'une tâche et écrit `workspace.created` dans son
   * journal, dans la même transaction.
   *
   * Le worktree existe déjà sur le disque quand on l'enregistre : c'est l'ordre
   * qui laisse une trace exploitable en cas d'échec. Un crash entre les deux
   * laisse un dossier sous `worktreesDir` que rien ne référence — visible, et
   * retirable. L'ordre inverse laisserait une ligne qui promet un dossier
   * absent.
   *
   * @returns le worktree, la tâche et l'événement ; `null` si la tâche n'existe pas
   * @throws si la tâche a déjà un worktree (contrainte d'unicité)
   */
  createWorkspace(input: {
    taskId: string
    repoDir: string
    subdir: string
    worktreePath: string
    branch: string
    baseCommit: string
    baseRef: string | null
    baseDirty: number
    submodules: readonly string[]
  }): (Recorded & { workspace: Workspace }) | null {
    const id = randomUUID()
    const now = new Date().toISOString()
    return this.tx(() => {
      if (!this.getTask(input.taskId)) return null
      this.db
        .prepare(
          `INSERT INTO workspaces (id, task_id, repo_dir, subdir, worktree_path, branch, base_commit,
                                   base_ref, base_dirty, submodules_json, status, created_at, updated_at)
           VALUES (:id, :task_id, :repo_dir, :subdir, :worktree_path, :branch, :base_commit,
                   :base_ref, :base_dirty, :submodules, 'active', :now, :now)`,
        )
        .run({
          id,
          task_id: input.taskId,
          repo_dir: input.repoDir,
          subdir: input.subdir,
          worktree_path: input.worktreePath,
          branch: input.branch,
          base_commit: input.baseCommit,
          base_ref: input.baseRef,
          base_dirty: input.baseDirty,
          submodules: JSON.stringify(input.submodules),
          now,
        })
      const workspace = this.getWorkspace(id)!
      const recorded = this.recordUnlocked(input.taskId, null, {
        type: 'workspace.created',
        payload: {
          workspace_id: id,
          branch: input.branch,
          base_commit: input.baseCommit,
          base_ref: input.baseRef,
          base_dirty: input.baseDirty,
          submodules: [...input.submodules],
          worktree_path: input.worktreePath,
        },
      })!
      return { ...recorded, workspace }
    })
  }

  /**
   * Fait avancer un worktree dans son cycle de vie et écrit l'événement
   * correspondant dans le journal de sa tâche, dans la même transaction.
   *
   * Seules deux transitions existent : `active → kept`, et `active|kept →
   * removed`. Une transition sans objet (déjà conservé, déjà retiré) rend
   * `null` au lieu d'écrire un second événement qui raconterait deux fois la
   * même chose.
   *
   * @param detail charge utile ajoutée à l'événement (motif, commit final…)
   * @returns le worktree après coup et l'événement écrit ; `null` si rien n'a changé
   */
  setWorkspaceStatus(
    id: string,
    to: Exclude<WorkspaceStatus, 'active'>,
    detail: Record<string, unknown> = {},
  ): (Recorded & { workspace: Workspace }) | null {
    const now = new Date().toISOString()
    const from: WorkspaceStatus[] = to === 'kept' ? ['active'] : ['active', 'kept']
    return this.tx(() => {
      const info = this.db
        .prepare(
          `UPDATE workspaces
           SET status = :to, updated_at = :now, removed_at = CASE WHEN :to = 'removed' THEN :now ELSE removed_at END
           WHERE id = :id AND status IN (${from.map((s) => `'${s}'`).join(', ')})`,
        )
        .run({ id, to, now })
      if (info.changes !== 1) return null
      const workspace = this.getWorkspace(id)!
      const recorded = this.recordUnlocked(workspace.task_id, null, {
        type: to === 'kept' ? 'workspace.kept' : 'workspace.removed',
        payload: { ...detail, workspace_id: id, branch: workspace.branch },
      })!
      return { ...recorded, workspace }
    })
  }

  /**
   * Passe en `kept` tous les worktrees restés `active`, à appeler au démarrage
   * du daemon après {@link HarnessStore.markInterrupted}.
   *
   * Leur tâche vient d'être interrompue ; le worktree, lui, est **conservé pour
   * inspection** (PLAN §3) — jamais nettoyé d'office : ce qu'il contient est
   * peut-être la seule trace de ce que l'agent avait fait.
   */
  keepActiveWorkspaces(): (Recorded & { workspace: Workspace })[] {
    const out: (Recorded & { workspace: Workspace })[] = []
    for (const w of this.listWorkspaces({ status: 'active' })) {
      const done = this.setWorkspaceStatus(w.id, 'kept', { reason: 'daemon redémarré' })
      if (done) out.push(done)
    }
    return out
  }

  getWorkspace(id: string): Workspace | null {
    const found = row<WorkspaceRow>(this.db.prepare('SELECT * FROM workspaces WHERE id = :id').get({ id }))
    return found ? toWorkspace(found) : null
  }

  /** Le worktree d'une tâche. @returns `null` si la tâche n'en a pas (profil en lecture seule) */
  workspaceForTask(taskId: string): Workspace | null {
    const found = row<WorkspaceRow>(
      this.db.prepare('SELECT * FROM workspaces WHERE task_id = :id').get({ id: taskId }),
    )
    return found ? toWorkspace(found) : null
  }

  // --- Liste blanche exec, par dépôt ----------------------------------------

  /**
   * Ajoute une commande à la liste blanche d'un dépôt.
   *
   * @param repoDir racine **canonique** du dépôt — celle que `inspectRepository`
   *        rend, et que le moteur consultera. Un chemin non canonique ne serait
   *        jamais retrouvé, et l'entrée ne servirait à rien sans le dire.
   * @returns `false` si l'argv y figurait déjà
   */
  addExecAllow(repoDir: string, argv: readonly string[], by: string): boolean {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO exec_allow (repo_dir, argv_json, added_at, added_by)
         VALUES (:repo, :argv, :at, :by)`,
      )
      .run({ repo: repoDir, argv: JSON.stringify(argv), at: new Date().toISOString(), by })
    return info.changes === 1
  }

  /** Retire une commande. @returns `false` si elle n'y figurait pas */
  removeExecAllow(repoDir: string, argv: readonly string[]): boolean {
    const info = this.db
      .prepare('DELETE FROM exec_allow WHERE repo_dir = :repo AND argv_json = :argv')
      .run({ repo: repoDir, argv: JSON.stringify(argv) })
    return info.changes === 1
  }

  /** Liste blanche d'un dépôt, ou de tous si `repoDir` est omis. */
  listExecAllow(repoDir?: string): ExecAllowEntry[] {
    const found = repoDir
      ? this.db.prepare('SELECT * FROM exec_allow WHERE repo_dir = :repo ORDER BY added_at, rowid').all({ repo: repoDir })
      : this.db.prepare('SELECT * FROM exec_allow ORDER BY repo_dir, added_at, rowid').all()
    return rows<{ repo_dir: string; argv_json: string; added_at: string; added_by: string }>(found).map((r) => ({
      repo_dir: r.repo_dir,
      argv: JSON.parse(r.argv_json) as string[],
      added_at: r.added_at,
      added_by: r.added_by,
    }))
  }

  /** Les worktrees, du plus récent au plus ancien. */
  listWorkspaces(filter: { status?: WorkspaceStatus; limit?: number } = {}): Workspace[] {
    const limit = filter.limit ?? 500
    const found = filter.status
      ? this.db
          .prepare('SELECT * FROM workspaces WHERE status = :s ORDER BY created_at DESC, rowid DESC LIMIT :l')
          .all({ s: filter.status, l: limit })
      : this.db.prepare('SELECT * FROM workspaces ORDER BY created_at DESC, rowid DESC LIMIT :l').all({ l: limit })
    return rows<WorkspaceRow>(found).map(toWorkspace)
  }
}

/** Ligne `approvals` telle que SQLite la rend. */
interface ApprovalRow {
  id: string
  task_id: string
  seq: number
  operation: string
  operation_json: string | null
  operation_hash: string
  status: string
  requested_at: string
  expires_at: string
  resolved_at: string | null
  resolved_by: string | null
  reason: string | null
}

/**
 * Convertit une ligne `approvals`. Elle était rendue telle quelle jusqu'à la
 * Slice 3, ses colonnes ayant la forme du contrat ; le détail en JSON exige
 * désormais une conversion — et un champ de plus dans l'objet rendu
 * (`operation_json`) qui n'appartient pas au contrat.
 */
function toApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    task_id: row.task_id,
    seq: row.seq,
    operation: row.operation,
    operation_detail: row.operation_json ? (JSON.parse(row.operation_json) as Record<string, unknown>) : null,
    operation_hash: row.operation_hash,
    status: row.status as ApprovalStatus,
    requested_at: row.requested_at,
    expires_at: row.expires_at,
    resolved_at: row.resolved_at,
    resolved_by: row.resolved_by,
    reason: row.reason,
  }
}

/** Variante de {@link toApproval} pour une ligne qui peut manquer. */
function toApprovalOrNull(value: unknown): Approval | null {
  const found = row<ApprovalRow>(value)
  return found ? toApproval(found) : null
}

/** Ligne `workspaces` telle que SQLite la rend. */
interface WorkspaceRow {
  id: string
  task_id: string
  repo_dir: string
  subdir: string
  worktree_path: string
  branch: string
  base_commit: string
  base_ref: string | null
  base_dirty: number
  submodules_json: string
  status: string
  created_at: string
  updated_at: string
  removed_at: string | null
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    task_id: row.task_id,
    repo_dir: row.repo_dir,
    subdir: row.subdir,
    worktree_path: row.worktree_path,
    branch: row.branch,
    base_commit: row.base_commit,
    base_ref: row.base_ref,
    base_dirty: row.base_dirty,
    submodules: JSON.parse(row.submodules_json) as string[],
    status: row.status as WorkspaceStatus,
    created_at: row.created_at,
    updated_at: row.updated_at,
    removed_at: row.removed_at,
  }
}

/** Ligne `provider_configs` telle que SQLite la rend. */
interface ProviderRow {
  id: string
  name: string
  kind: string
  preset: string
  base_url: string | null
  default_model: string
  secret_ref: string | null
  web_search: string
  created_at: string
  updated_at: string
  last_test_json: string | null
}

function toProvider(row: ProviderRow): ProviderConfig {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as ProviderKind,
    preset: row.preset as ProviderPreset,
    base_url: row.base_url,
    default_model: row.default_model,
    secret_ref: row.secret_ref,
    web_search: row.web_search as WebSearchMode,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_test: row.last_test_json ? (JSON.parse(row.last_test_json) as ConnectionTest) : null,
  }
}

/** Ligne `agents` telle que SQLite la rend. */
interface AgentRow {
  id: string
  name: string
  kind: string
  description: string
  provider_id: string | null
  model: string | null
  system_prompt: string
  tools_json: string
  limits_json: string
  enabled: number
  created_at: string
  updated_at: string
}

function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as AgentKind,
    description: row.description,
    provider_id: row.provider_id,
    model: row.model,
    system_prompt: row.system_prompt,
    tools: JSON.parse(row.tools_json) as string[],
    limits: JSON.parse(row.limits_json) as AgentLimits,
    enabled: row.enabled === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/** Ligne `tool_calls` telle que SQLite la rend. */
interface ToolCallRow {
  id: string
  task_id: string
  step: number
  call_id: string
  name: string
  status: string
  decision: string
  arguments_json: string
  result_summary: string | null
  result_bytes: number | null
  duration_ms: number | null
  error: string | null
  requested_at: string
  ended_at: string | null
}

function toToolCall(row: ToolCallRow): ToolCall {
  return {
    id: row.id,
    task_id: row.task_id,
    step: row.step,
    call_id: row.call_id,
    name: row.name,
    status: row.status as ToolCallStatus,
    decision: row.decision as ToolDecision,
    arguments_json: row.arguments_json,
    result_summary: row.result_summary,
    result_bytes: row.result_bytes,
    duration_ms: row.duration_ms,
    error: row.error,
    requested_at: row.requested_at,
    ended_at: row.ended_at,
  }
}
