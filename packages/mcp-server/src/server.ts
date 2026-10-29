/**
 * @file Serveur MCP du harness, lancé par Claude Code en stdio.
 *
 * Rôle : **adaptateur mince**. Il traduit les appels d'outils de Claude en
 * requêtes HTTP vers le daemon, et ne détient aucune logique métier. Chaque
 * session Claude Code a son propre serveur MCP ; tous parlent au même daemon,
 * qu'ils démarrent au besoin.
 *
 * ## Deux invariants hérités de la Slice 0, à ne pas casser
 *
 * **Aucun outil d'approbation n'est exposé.** L'approbation est un acte humain.
 * Si Claude pouvait approuver, le contrôle humain n'aurait plus de sens. Chaque
 * réponse qui signale une pause porte la consigne exacte destinée à l'humain
 * (`approval_instructions`), que Claude n'a plus qu'à transmettre.
 *
 * **Une pause n'est annoncée qu'une fois par client.** Le serveur retient, par
 * tâche, le numéro de la dernière pause qu'il a signalée à *son* client. La
 * première annonce rend `human_approval_pending` ; ensuite, l'attente **bloque**
 * jusqu'à la décision humaine. Sans cela, Claude rappelait l'attente comme la
 * consigne le lui demandait, obtenait la même réponse en deux millisecondes,
 * et renonçait — ou bouclait en consommant des tokens à chaque aller-retour.
 *
 * ⚠️ stdout est le canal JSON-RPC avec Claude Code : y écrire quoi que ce soit
 * d'autre corrompt le protocole. Journaliser uniquement sur stderr.
 *
 * Les descriptions d'outils et les messages renvoyés sont en anglais : c'est le
 * texte que lit le modèle, pas l'utilisateur.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  isActionable,
  type Approval,
  type HarnessConfig,
  type Health,
  type NextAction,
  type Task,
  type TaskView,
} from '@midgaard/contracts'
import { callDaemon } from './daemon-client.ts'
import { approvalInstructions } from './instructions.ts'
import { createTracer } from './trace.ts'

/** Réponse d'attente du daemon. */
type WaitBody = TaskView & { waited_ms: number; error?: string }

/**
 * Consigne en clair jointe à chaque `next_action`.
 *
 * Celle de `human_approval_pending` interdit explicitement à Claude d'approuver
 * lui-même, et lui demande de **prévenir l'utilisateur avant** de rappeler
 * l'attente : l'attente suivante bloque jusqu'à la décision, donc un message
 * écrit après n'arriverait qu'une fois l'approbation donnée.
 */
const HINTS: Record<NextAction, string> = {
  result_ready: 'The task finished. Its result is included above.',
  call_wait_for_task_again: 'Still running. Call harness_wait_for_task again with the same task_id.',
  human_approval_pending:
    'Blocked on human approval, which you cannot give yourself. First tell the user, relaying ' +
    'approval_instructions verbatim. Then call harness_wait_for_task again: it blocks until the human decides.',
  still_waiting_for_human:
    'The human has not decided yet; you already told them. Call harness_wait_for_task again to keep ' +
    'waiting, or tell the user you are still waiting for their approval.',
  task_ended_without_result:
    'The task ended without a result (see status and error). Do not retry automatically; tell the user.',
}

/** Résultat d'outil réussi : un objet JSON indenté, lisible par le modèle. */
function ok(payload: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] }
}

/**
 * Résultat d'outil en erreur. On renvoie l'erreur au modèle (`isError`) plutôt
 * que de lever : il peut alors la lire et réagir.
 */
function fail(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: message }] }
}

/**
 * Construit le serveur MCP.
 *
 * @param config configuration injectée
 * @param log    journalisation sur stderr
 */
export function createMcpServer(config: HarnessConfig, log: (...a: unknown[]) => void): McpServer {
  const server = new McpServer(
    { name: 'midgaard-harness', version: '0.1.0' },
    {
      // Transmises à Claude à la connexion : mode d'emploi global, en complément
      // des descriptions d'outils. Aucune mention du dashboard : à ce moment, le
      // serveur n'a pas encore interrogé le daemon et ne sait pas s'il est servi.
      // Cette information arrive, vérifiée, dans `approval_instructions`.
      instructions:
        'Midgaard delegates work to executor agents and tracks it. Workflow: harness_delegate_task returns ' +
        'a task_id immediately; then call harness_wait_for_task, which blocks until the task finishes, needs ' +
        'human approval, or the timeout elapses. Follow the next_action field of every response. ' +
        'Approvals are given by the human, never by you: when a response says human_approval_pending, relay ' +
        'its approval_instructions to the user verbatim, then keep waiting.',
    },
  )

  const trace = createTracer(config, () => server.server.getClientVersion())
  const call = <T>(path: string, init?: RequestInit) => callDaemon<T>(config, log, path, init)

  /**
   * Trace les capacités annoncées par le client à la connexion.
   *
   * C'est l'instrumentation qui tranchera l'adoption des « Tasks » MCP natives
   * (`tasks/get`, `tasks/result`, `tasks/cancel`), primitive du protocole pour
   * les requêtes longues qui pourrait remplacer notre `harness_wait_for_task`.
   * Elle n'est utilisable que si **le client** la déclare : un serveur qui
   * l'impose unilatéralement casserait tous les clients qui l'ignorent. La
   * réponse ne peut venir que d'une vraie session Claude Code — la suite de tests
   * utilise le client du SDK, qui ne prouve rien du client réel.
   */
  server.server.oninitialized = () => {
    const capabilities = server.server.getClientCapabilities()
    trace('client.initialized', {
      capabilities,
      supports_native_tasks: capabilities?.tasks !== undefined,
    })
  }

  /**
   * Dernière pause d'approbation signalée à ce client, par tâche.
   *
   * En mémoire, et c'est voulu : la mémoire doit être celle d'**un client**, pas
   * du harness. Un serveur MCP par session Claude Code, donc une mémoire par
   * session. S'il redémarre, la pause en cours est simplement annoncée une fois
   * de plus — comportement sûr.
   */
  const reportedApproval = new Map<string, number>()

  /** URL du dashboard si, et seulement si, il est réellement servi. */
  async function dashboardUrl(): Promise<string | null> {
    try {
      const { body } = await call<Health>('/api/health')
      return body.dashboard_available ? body.dashboard_url : null
    } catch {
      return null
    }
  }

  /**
   * Formate l'état d'une tâche pour Claude.
   *
   * Pour une pause d'approbation, distingue une pause **nouvelle pour ce client**
   * (`human_approval_pending`, alors mémorisée) d'une pause déjà annoncée
   * (`still_waiting_for_human`). Les deux portent `approval_instructions`.
   */
  async function summarize(
    view: { task: Task; next_action: NextAction; approval: Approval | null },
    extra: Record<string, unknown> = {},
  ) {
    const { task } = view
    let action = view.next_action
    let approval: Record<string, unknown> = {}

    if (action === 'human_approval_pending') {
      if (task.approval_seq <= (reportedApproval.get(task.id) ?? 0)) action = 'still_waiting_for_human'
      else reportedApproval.set(task.id, task.approval_seq)
      if (view.approval) {
        approval = {
          approval_id: view.approval.id,
          approval_instructions: approvalInstructions(
            view.approval.id,
            view.approval.operation,
            await dashboardUrl(),
          ),
          approval_expires_at: view.approval.expires_at,
        }
      }
    }

    return ok({
      task_id: task.id,
      status: task.status,
      step: `${task.step}/${task.steps_total}`,
      next_action: action,
      ...extra,
      ...approval,
      ...(task.result ? { result: task.result } : {}),
      ...(task.error ? { error: task.error } : {}),
      hint: HINTS[action],
    })
  }

  /** Schéma commun du paramètre `task_id` : rejeté avant tout appel au daemon si malformé. */
  const taskId = z.uuid().describe('Identifier returned by harness_delegate_task')

  // Les `annotations` décrivent la nature de chaque outil au client : lecture
  // seule, destructif, idempotent, accès au monde extérieur.

  server.registerTool(
    'harness_ping',
    {
      title: 'Ping the harness daemon',
      description: 'Check that the Midgaard daemon is reachable. Starts it if needed.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const { body } = await call<Health>('/api/health')
      return ok({ ...body })
    },
  )

  server.registerTool(
    'harness_delegate_task',
    {
      title: 'Delegate a task',
      description:
        'Start a task and return its task_id immediately, without waiting. ' +
        'SLICE 1: tasks are simulated (timed steps) — no real executor agent runs yet.',
      inputSchema: {
        objective: z.string().min(1).max(4000).describe('What the executor must achieve'),
        duration_s: z.number().int().min(1).max(900).default(20).describe('Simulated duration in seconds'),
        needs_approval: z.boolean().default(false).describe('Simulate a step that requires human approval'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ objective, duration_s, needs_approval }) => {
      const { status, body } = await call<TaskView & { error?: string }>('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({ objective, duration_s, needs_approval }),
      })
      if (status !== 201) return fail(`Delegation refused: ${body.error ?? status}`)
      return ok({
        task_id: body.task.id,
        status: body.task.status,
        hint: 'Call harness_wait_for_task with this task_id to block until it finishes.',
      })
    },
  )

  /**
   * Attente bloquante, cœur de l'ergonomie du harness : Claude attend sans
   * dépenser de tokens à interroger le statut en boucle.
   *
   * Fonctionnement : une suite de long-polls courts (`waitSliceMs`) vers le
   * daemon, jusqu'à un état utile ou l'expiration de `timeout_s`. Entre deux
   * tranches, si le client a fourni un jeton de progression, on lui envoie une
   * notification — c'est ce qui empêche un client réglé à 60 s de couper l'appel.
   *
   * Si le client interrompt l'appel, seule l'**attente** s'arrête : la tâche
   * continue. L'arrêter demande un `harness_cancel_task` explicite.
   */
  server.registerTool(
    'harness_wait_for_task',
    {
      title: 'Wait for a task',
      description:
        'Block until the task completes, fails, reaches a new human-approval pause, or timeout_s elapses — ' +
        'whichever comes first. If the task is paused on an approval you already reported, this blocks until ' +
        'the human decides. Prefer this over polling harness_get_task_status. Interrupting the wait does not ' +
        'cancel the task.',
      inputSchema: {
        task_id: taskId,
        timeout_s: z.number().int().min(1).max(600).default(120).describe('Maximum time to block, in seconds'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ task_id, timeout_s }, extra) => {
      const started = Date.now()
      const deadline = started + timeout_s * 1000
      // Présent seulement si le client veut des notifications de progression.
      const progressToken = extra._meta?.progressToken
      // Pause déjà signalée à ce client : elle ne doit pas interrompre cette attente.
      const known = reportedApproval.get(task_id) ?? 0
      let last: WaitBody | undefined
      let notifications = 0
      trace('wait.start', {
        task_id,
        timeout_s,
        known_approval: known,
        has_progress_token: progressToken !== undefined,
      })

      while (true) {
        const sliceMs = Math.max(0, Math.min(config.waitSliceMs, deadline - Date.now()))
        let res: { status: number; body: WaitBody }
        try {
          res = await call<WaitBody>(
            `/api/tasks/${task_id}/wait?timeout_ms=${sliceMs}&known_approval=${known}`,
            // Relayer l'annulation du client : si Claude Code abandonne l'appel,
            // la requête vers le daemon est coupée et le long-poll libéré.
            { signal: extra.signal },
          )
        } catch (e) {
          if (extra.signal.aborted) {
            log(`attente ${task_id.slice(0, 8)} interrompue par le client, la tâche continue`)
            trace('wait.aborted', { task_id, after_s: (Date.now() - started) / 1000, notifications })
            return fail('Wait interrupted by the client. The task keeps running.')
          }
          throw e
        }
        if (res.status !== 200) return fail(`Unknown task or daemon error: ${res.body.error ?? res.status}`)
        last = res.body
        if (isActionable(last.task, known) || Date.now() >= deadline) break

        if (progressToken !== undefined) {
          const elapsed = (Date.now() - started) / 1000
          // `progress` doit croître strictement (spec MCP) : on mesure le temps
          // d'attente, pas le numéro d'étape, qui peut rester identique.
          await extra.sendNotification({
            method: 'notifications/progress',
            params: {
              progressToken,
              progress: elapsed,
              total: timeout_s,
              message: `${last.task.status} — step ${last.task.step}/${last.task.steps_total}`,
            },
          })
          notifications++
        }
      }

      trace('wait.end', {
        task_id,
        after_s: (Date.now() - started) / 1000,
        notifications,
        next_action: last.next_action,
      })
      return summarize(last, { waited_s: Math.round((Date.now() - started) / 100) / 10 })
    },
  )

  server.registerTool(
    'harness_get_task_status',
    {
      title: 'Get task status',
      description: 'Return the current status of a task without waiting.',
      inputSchema: { task_id: taskId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ task_id }) => {
      const { status, body } = await call<TaskView & { error?: string }>(`/api/tasks/${task_id}`)
      if (status !== 200) return fail(`Unknown task: ${body.error ?? status}`)
      return summarize(body)
    },
  )

  server.registerTool(
    'harness_get_task_result',
    {
      title: 'Get task result',
      description:
        'Return the structured result of a finished task. If the task is still running, this does not ' +
        'wait — use harness_wait_for_task instead.',
      inputSchema: { task_id: taskId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ task_id }) => {
      const { status, body } = await call<TaskView & { error?: string }>(`/api/tasks/${task_id}`)
      if (status !== 200) return fail(`Unknown task: ${body.error ?? status}`)
      if (body.task.status !== 'completed') {
        return summarize(body, {
          note: 'No result: the task is not completed. See status and next_action.',
        })
      }
      return ok({
        task_id: body.task.id,
        status: body.task.status,
        result: body.task.result,
        started_at: body.task.started_at,
        ended_at: body.task.ended_at,
      })
    },
  )

  server.registerTool(
    'harness_cancel_task',
    {
      title: 'Cancel a task',
      description:
        'Request cancellation of a running task. A running task stops at its next checkpoint; a task ' +
        'paused on an approval stops immediately.',
      inputSchema: {
        task_id: taskId,
        reason: z.string().max(500).optional().describe('Why the task is being cancelled'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ task_id, reason }) => {
      const { status, body } = await call<TaskView & { error?: string; status?: string }>(
        `/api/tasks/${task_id}/cancel`,
        { method: 'POST', body: JSON.stringify({ reason }) },
      )
      // 409 : la tâche est déjà finie. Signalé comme erreur, pour que Claude ne
      // croie pas l'avoir annulée.
      if (status === 409) return fail(`Task already ended with status ${body.status}.`)
      if (status !== 200) return fail(`Unknown task: ${body.error ?? status}`)
      return ok({ task_id, status: body.task.status })
    },
  )

  return server
}
