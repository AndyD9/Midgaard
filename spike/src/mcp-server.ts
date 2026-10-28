/**
 * @file Serveur MCP du harness, lancé par Claude Code en stdio.
 *
 * Rôle : **adaptateur mince**. Il traduit les appels d'outils de Claude en requêtes
 * HTTP vers le daemon, et ne détient aucun état métier. Chaque session Claude Code
 * a son propre serveur MCP, mais tous parlent au même daemon, qu'ils démarrent
 * au besoin.
 *
 * Outils exposés à Claude :
 *  - `harness_ping` : vérifie (et démarre si besoin) le daemon ;
 *  - `harness_delegate_task` : crée une tâche, rend son identifiant sans attendre ;
 *  - `harness_wait_for_task` : bloque jusqu'à un état utile ou un délai ;
 *  - `harness_get_task_status` : état instantané, sans attendre ;
 *  - `harness_cancel_task` : annulation explicite.
 *
 * **Aucun outil d'approbation** : l'approbation est un acte humain (CLI
 * `approve.ts` dans le spike, dashboard en Slice 1). Si Claude pouvait approuver,
 * le contrôle humain n'aurait plus de sens. Chaque réponse qui signale une
 * approbation contient la consigne exacte destinée à l'humain
 * (`approval_instructions`), que Claude n'a plus qu'à transmettre.
 *
 * Le serveur retient, pour chaque tâche, la dernière pause d'approbation qu'il a
 * signalée à **son** client : une pause n'est annoncée qu'une fois, puis les
 * attentes suivantes bloquent jusqu'à la décision humaine. Un serveur MCP par
 * session Claude Code, donc une mémoire par client.
 *
 * Les descriptions d'outils et les messages renvoyés sont en anglais : c'est le
 * texte que lit le modèle, pas l'utilisateur.
 *
 * ⚠️ stdout est le canal JSON-RPC avec Claude Code : y écrire quoi que ce soit
 * d'autre corrompt le protocole. Journaliser uniquement sur stderr.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  DAEMON_ENTRY, HOME, LOG_FILE, PROTOCOL_VERSION, SPIKE_ROOT, daemonFetch, isActionable, pidAlive, readRuntime,
  type NextAction, type RuntimeInfo, type Task,
} from './shared.ts'

/**
 * Durée d'une tranche de long-poll vers le daemon, et donc intervalle entre deux
 * notifications de progression. Doit rester sous deux limites mesurées :
 *  - le client MCP du SDK coupe un appel d'outil à **60 s** sans progression
 *    (constat S5 du spike) — 15 s laisse une marge ×4 ;
 *  - `fetch` (undici) abandonne une requête sans en-têtes de réponse au bout de 300 s.
 */
const SLICE_MS = 15_000
/** Délai maximal accordé à un daemon fraîchement lancé pour devenir joignable. */
const DAEMON_BOOT_MS = 5_000
/** Délai maximal accordé à un daemon d'une autre version pour s'arrêter avant son remplacement. */
const DAEMON_STOP_MS = 3_000

/** Journalise sur stderr (jamais stdout, voir l'en-tête). */
const log = (...a: unknown[]) => console.error(new Date().toISOString(), '[mcp]', ...a)

// --- Trace de diagnostic ---------------------------------------------------

/**
 * Fichier JSONL qui enregistre chaque attente : client, présence d'un jeton de
 * progression, durée réelle, issue. Il sert à vérifier le comportement du vrai
 * client Claude Code, que la suite de test ne peut pas simuler. Fichier plutôt
 * que stderr, car Claude Code ne montre pas le stderr des serveurs MCP.
 */
const TRACE_FILE = join(HOME, 'mcp-trace.jsonl')

/**
 * Ajoute un événement à la trace. Ne lève jamais : un échec de diagnostic ne
 * doit pas faire échouer l'appel d'outil.
 * @param event nom de l'événement (`wait.start`, `wait.end`, `wait.aborted`)
 * @param data  champs propres à l'événement
 */
function trace(event: string, data: Record<string, unknown>): void {
  try {
    mkdirSync(HOME, { recursive: true, mode: 0o700 })
    appendFileSync(TRACE_FILE, JSON.stringify({ at: new Date().toISOString(), event, client: server.server.getClientVersion(), ...data }) + '\n', { mode: 0o600 })
  } catch {}
}

// --- Daemon ----------------------------------------------------------------

/**
 * Interroge le daemon décrit par `rt`, avec un délai court (1 s).
 * @returns `ok` s'il répond avec notre version de protocole, `outdated` s'il répond
 *          avec une autre (ou sans version : daemon v1), `down` s'il ne répond pas
 */
async function probe(rt: RuntimeInfo): Promise<'ok' | 'outdated' | 'down'> {
  try {
    const r = await daemonFetch(rt, '/health', { signal: AbortSignal.timeout(1_000) })
    if (!r.ok) return 'down'
    const body = (await r.json()) as { protocol?: number }
    return body.protocol === PROTOCOL_VERSION ? 'ok' : 'outdated'
  } catch {
    return 'down'
  }
}

/**
 * Demande à un daemon d'une autre version de s'arrêter, puis attend que son
 * processus ait vraiment disparu : tant qu'il vit, il détient le verrou, et un
 * nouveau daemon renoncerait aussitôt à démarrer.
 */
async function retire(rt: RuntimeInfo): Promise<void> {
  log(`daemon d'une autre version (pid ${rt.pid}), remplacement`)
  await daemonFetch(rt, '/shutdown', { method: 'POST', signal: AbortSignal.timeout(1_000) }).catch(() => {})
  const deadline = Date.now() + DAEMON_STOP_MS
  while (pidAlive(rt.pid) && Date.now() < deadline) await sleep(50)
}

/**
 * Renvoie un daemon joignable, en le démarrant si nécessaire.
 *
 * Si le fichier de découverte désigne un daemon qui répond avec notre version de
 * protocole, on l'utilise. S'il répond avec une autre version (code mis à jour
 * pendant qu'il tournait), on l'arrête d'abord. Puis on lance un nouveau daemon,
 * **détaché** pour qu'il survive à la fin de cette session Claude Code, et on
 * attend qu'il publie un fichier de découverte valide.
 *
 * Si plusieurs serveurs MCP font ça en même temps, le verrou du daemon garantit
 * qu'un seul survit ; tous finissent par lire le même fichier de découverte.
 *
 * @throws si aucun daemon ne répond après `DAEMON_BOOT_MS`
 */
async function ensureDaemon(): Promise<RuntimeInfo> {
  const current = readRuntime()
  const state = current ? await probe(current) : 'down'
  if (state === 'ok') return current!
  if (state === 'outdated') await retire(current!)

  log('daemon absent, démarrage')
  mkdirSync(HOME, { recursive: true, mode: 0o700 })
  const out = openSync(LOG_FILE, 'a', 0o600)
  // Détaché : le daemon survit à la session Claude Code qui l'a lancé.
  // stdin ignoré, stdout/stderr vers le journal : surtout pas notre stdout (canal JSON-RPC).
  spawn(process.execPath, [DAEMON_ENTRY], { detached: true, stdio: ['ignore', out, out] }).unref()

  const deadline = Date.now() + DAEMON_BOOT_MS
  while (Date.now() < deadline) {
    await sleep(100)
    const rt = readRuntime()
    // `rt.pid !== current?.pid` : ignorer un fichier périmé laissé par un daemon mort.
    if (rt && rt.pid !== current?.pid && (await probe(rt)) === 'ok') return rt
  }
  throw new Error(`le daemon n'a pas démarré en ${DAEMON_BOOT_MS} ms (voir ${LOG_FILE})`)
}

/**
 * Appelle le daemon et parse sa réponse JSON.
 *
 * Relit le fichier de découverte à chaque appel : port et jeton changent si le
 * daemon redémarre. En cas d'erreur réseau, retente **une fois** après avoir
 * relancé le daemon (cas d'un daemon tué en cours de session, scénario S7).
 * Pas de nouvelle tentative si l'appel a été interrompu volontairement.
 *
 * @returns le code HTTP et le corps parsé, à interpréter par l'appelant
 */
async function call<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  let rt = await ensureDaemon()
  let res: Response
  try {
    res = await daemonFetch(rt, path, init)
  } catch (e) {
    if (init.signal?.aborted) throw e
    log('daemon injoignable, nouvelle tentative', (e as Error).message)
    rt = await ensureDaemon()
    res = await daemonFetch(rt, path, init)
  }
  return { status: res.status, body: (await res.json()) as T }
}

// --- Formatage des réponses ------------------------------------------------

/**
 * Consigne en clair jointe à chaque `next_action`. Celle de
 * `human_approval_pending` interdit explicitement à Claude d'approuver lui-même,
 * et lui demande de **prévenir l'utilisateur avant** de rappeler l'attente :
 * l'attente suivante bloque jusqu'à la décision, donc un message écrit après
 * n'arriverait qu'une fois l'approbation donnée.
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
  task_ended_without_result: 'The task ended without a result (see status). Do not retry automatically.',
}

/**
 * Dernière pause d'approbation signalée à ce client, par tâche. Sert à ne pas
 * annoncer deux fois la même pause, et à faire bloquer les attentes suivantes
 * jusqu'à la décision humaine. En mémoire : perdue si le serveur MCP redémarre,
 * auquel cas la pause en cours est simplement annoncée une fois de plus.
 */
const reportedApproval = new Map<string, number>()

/**
 * Consigne destinée à l'humain pour approuver une tâche : une commande complète,
 * avec le chemin et l'identifiant réels, à copier telle quelle. Aucun placeholder,
 * et aucune mention d'un outil qui n'existe pas encore (défaut n° 1 du test réel :
 * Claude avait renvoyé l'utilisateur vers un dashboard inexistant).
 * Le dashboard de la Slice 1 remplacera la commande par un lien.
 */
function approvalInstructions(taskId: string): string {
  return `To approve, the user runs in a terminal: cd ${JSON.stringify(SPIKE_ROOT)} && npm run approve -- ${taskId}`
}

/** Résultat d'outil réussi : un objet JSON indenté, lisible par le modèle. */
function ok(payload: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] }
}

/**
 * Résultat d'outil en erreur (`isError`). On renvoie l'erreur au modèle plutôt que
 * de lever une exception, pour qu'il puisse la lire et réagir.
 */
function fail(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: message }] }
}

/**
 * Formate l'état d'une tâche pour Claude : statut, progression, consigne et,
 * si la tâche est finie, son résultat.
 *
 * Pour une pause d'approbation, distingue une pause nouvelle pour ce client
 * (`human_approval_pending`, alors mémorisée comme signalée) d'une pause déjà
 * annoncée (`still_waiting_for_human`). Les deux portent `approval_instructions`.
 *
 * @param nextAction consigne calculée par le daemon à partir du seul statut
 * @param extra      champs supplémentaires (par exemple `waited_s`)
 */
function summarize(task: Task, nextAction: NextAction, extra: Record<string, unknown> = {}) {
  let action = nextAction
  let approval = {}
  if (nextAction === 'human_approval_pending') {
    if (task.approval_seq <= (reportedApproval.get(task.id) ?? 0)) action = 'still_waiting_for_human'
    else reportedApproval.set(task.id, task.approval_seq)
    approval = { approval_instructions: approvalInstructions(task.id) }
  }
  return ok({
    task_id: task.id,
    status: task.status,
    step: `${task.step}/${task.steps_total}`,
    next_action: action,
    ...extra,
    ...approval,
    ...(task.result ? { result: task.result } : {}),
    hint: HINTS[action],
  })
}

// --- Serveur ---------------------------------------------------------------

/**
 * Les `instructions` sont transmises à Claude à la connexion : c'est le mode
 * d'emploi global du harness, en complément des descriptions d'outils.
 */
const server = new McpServer(
  { name: 'midgaard-harness', version: '0.0.0-spike' },
  {
    instructions:
      'Midgaard delegates work to executor agents and tracks it. Workflow: harness_delegate_task returns a ' +
      'task_id immediately; then call harness_wait_for_task, which blocks until the task finishes, needs ' +
      'human approval, or the timeout elapses. Follow the next_action field of every response. ' +
      'Approvals are given by the human, never by you: when a response says human_approval_pending, ' +
      'relay its approval_instructions to the user, then keep waiting.',
  },
)

/** Schéma commun du paramètre `task_id` : un UUID, rejeté avant tout appel au daemon sinon. */
const taskId = z.string().uuid().describe('Identifier returned by harness_delegate_task')

// Les `annotations` décrivent la nature de chaque outil au client
// (lecture seule, destructif, idempotent, accès au monde extérieur).

server.registerTool(
  'harness_ping',
  {
    title: 'Ping the harness daemon',
    description: 'Check that the Midgaard daemon is reachable. Starts it if needed.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    const { body } = await call<Record<string, unknown>>('/health')
    return ok(body)
  },
)

server.registerTool(
  'harness_delegate_task',
  {
    title: 'Delegate a task',
    description:
      'Start a task and return its task_id immediately, without waiting. ' +
      'SPIKE: tasks are simulated (timed steps), no real agent runs yet.',
    inputSchema: {
      objective: z.string().min(1).max(4000).describe('What the executor must achieve'),
      duration_s: z.number().int().min(1).max(900).default(20).describe('Simulated duration'),
      needs_approval: z.boolean().default(false).describe('Simulate a step that requires human approval'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ objective, duration_s, needs_approval }) => {
    const { status, body } = await call<Task & { error?: string }>('/tasks', {
      method: 'POST',
      body: JSON.stringify({ objective, duration_s, needs_approval }),
    })
    if (status !== 201) return fail(`Delegation refused: ${body.error}`)
    return ok({
      task_id: body.id,
      status: body.status,
      hint: 'Call harness_wait_for_task with this task_id to block until it finishes.',
    })
  },
)

/**
 * Attente bloquante, cœur de l'ergonomie du harness : Claude attend sans
 * consommer de tokens à interroger le statut en boucle.
 *
 * Rend la main sur une fin de tâche, une pause d'approbation **pas encore
 * signalée à ce client**, ou l'expiration du délai. Une pause déjà signalée
 * n'interrompt pas l'attente : l'appel bloque jusqu'à la décision humaine, puis
 * continue jusqu'à la fin de la tâche si le délai le permet.
 *
 * Fonctionnement : une suite de long-polls courts (`SLICE_MS`) vers le daemon,
 * jusqu'à un état utile ou l'expiration de `timeout_s`. Entre deux tranches, si le
 * client a fourni un jeton de progression, on lui envoie une notification : c'est
 * ce qui empêche un client réglé à 60 s de couper l'appel (scénarios S5 et S6).
 *
 * Si le client interrompt l'appel (l'utilisateur appuie sur Échap, par exemple),
 * seule l'**attente** s'arrête : la tâche continue. Arrêter une tâche demande un
 * `harness_cancel_task` explicite.
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
      timeout_s: z.number().int().min(1).max(600).default(120).describe('Maximum time to block'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ task_id, timeout_s }, extra) => {
    const started = Date.now()
    const deadline = started + timeout_s * 1000
    // Présent seulement si le client veut des notifications de progression.
    const progressToken = extra._meta?.progressToken
    let last: { task: Task; next_action: NextAction } | undefined
    let notifications = 0
    // Pause déjà signalée à ce client : elle ne doit pas interrompre cette attente.
    const known = reportedApproval.get(task_id) ?? 0
    trace('wait.start', { task_id, timeout_s, known_approval: known, has_progress_token: progressToken !== undefined })

    // Long-poll par tranches : chaque tranche est une requête courte vers le daemon,
    // et une notification de progression entre deux tranches garde le client en vie.
    while (true) {
      const sliceMs = Math.max(0, Math.min(SLICE_MS, deadline - Date.now()))
      let res
      try {
        res = await call<{ task: Task; next_action: NextAction; error?: string }>(
          `/tasks/${task_id}/wait?timeout_ms=${sliceMs}&known_approval=${known}`,
          // Relayer le signal d'annulation du client : si Claude Code abandonne l'appel,
          // la requête vers le daemon est coupée aussitôt, et le daemon libère le long-poll.
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
      if (res.status !== 200) return fail(`Unknown task or daemon error: ${res.body.error}`)
      last = res.body
      if (isActionable(last.task, known) || Date.now() >= deadline) break

      if (progressToken !== undefined) {
        const elapsed = (Date.now() - started) / 1000
        // `progress` doit croître strictement (spec MCP) : on mesure l'attente, pas les étapes.
        // Le numéro d'étape peut rester identique d'une tranche à l'autre, il va donc dans `message`.
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

    trace('wait.end', { task_id, after_s: (Date.now() - started) / 1000, notifications, next_action: last.next_action })
    return summarize(last.task, last.next_action, { waited_s: Math.round((Date.now() - started) / 100) / 10 })
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
    const { status, body } = await call<{ task: Task; next_action: NextAction; error?: string }>(`/tasks/${task_id}`)
    if (status !== 200) return fail(`Unknown task: ${body.error}`)
    return summarize(body.task, body.next_action)
  },
)

server.registerTool(
  'harness_cancel_task',
  {
    title: 'Cancel a task',
    description: 'Request cancellation of a running task.',
    inputSchema: { task_id: taskId },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async ({ task_id }) => {
    const { status, body } = await call<{ task: Task; error?: string; status?: string }>(
      `/tasks/${task_id}/cancel`,
      { method: 'POST' },
    )
    // 409 : la tâche est déjà finie. Signalé comme erreur pour que Claude ne croie pas l'avoir annulée.
    if (status === 409) return fail(`Task already ended with status ${body.status}.`)
    if (status !== 200) return fail(`Unknown task: ${body.error}`)
    return ok({ task_id, status: body.task.status })
  },
)

// Le daemon n'est pas démarré ici mais au premier appel d'outil : une session qui
// n'utilise jamais le harness ne lance aucun processus en arrière-plan.
await server.connect(new StdioServerTransport())
log('serveur MCP prêt sur stdio')
