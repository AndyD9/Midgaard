/**
 * @file Routeur HTTP du daemon.
 *
 * Deux familles de routes, avec deux régimes d'authentification :
 *
 *  - **`/api/…`** : jeton porteur obligatoire. Utilisées par le serveur MCP, la
 *    CLI, les tests et le dashboard une fois chargé.
 *  - **`/ui/bootstrap` et les fichiers du dashboard** : pas de jeton, car le
 *    navigateur n'en a aucun avant d'avoir chargé la page. Ces routes restent
 *    protégées par les contrôles d'enveloppe (`Host` exact, `Origin` en liste
 *    blanche, `Sec-Fetch-Site`), qui sont précisément ce qui arrête une page web
 *    malveillante. `/ui/bootstrap` remet le jeton d'API à la page ainsi servie.
 *
 * Les contrôles de sécurité passent **avant** le routage, y compris avant de
 * savoir si la route existe : un client refusé ne doit rien apprendre de l'API.
 *
 * | Méthode | Chemin | Rôle | Codes |
 * |---|---|---|---|
 * | GET  | `/api/health` | Vivacité, version de protocole, compteurs | 200 |
 * | POST | `/api/tasks` | Crée une tâche | 201, 400 |
 * | GET  | `/api/tasks?status=&limit=` | Liste les tâches | 200 |
 * | GET  | `/api/tasks/:id` | État et consigne | 200, 404 |
 * | GET  | `/api/tasks/:id/wait?timeout_ms=&known_approval=` | Long-poll | 200, 404 |
 * | GET  | `/api/tasks/:id/events` | Timeline complète | 200, 404 |
 * | POST | `/api/tasks/:id/cancel` | Annulation | 200, 404, 409 |
 * | GET  | `/api/approvals` | Demandes en attente | 200 |
 * | POST | `/api/approvals/:id/approve` | Décision humaine | 200, 404, 409 |
 * | POST | `/api/approvals/:id/reject` | Décision humaine | 200, 404, 409 |
 * | POST | `/api/shutdown` | Arrêt propre | 200 |
 * | GET  | `/ui/bootstrap` | Jeton d'API pour le dashboard | 200 |
 * | GET  | `/*` | Fichiers du dashboard | 200, 404 |
 *
 * Erreurs communes : 401 sans jeton valide, 403 sur enveloppe refusée, 400 sur
 * corps invalide ou trop gros, 405 sur méthode inconnue.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createTaskRequestSchema, type Health } from '@midgaard/contracts'
import type { HarnessStore } from '@midgaard/persistence'
import type { TaskManager } from './task-manager.ts'
import type { StaticFiles } from './static-files.ts'
import { checkEnvelope, checkToken, type SecurityContext } from './security.ts'

/** Taille maximale d'un corps de requête, contre l'épuisement mémoire. */
const MAX_BODY_BYTES = 64 * 1024

/** Ce que le routeur emprunte au daemon. */
export interface HttpDeps {
  store: HarnessStore
  tasks: TaskManager
  files: StaticFiles
  security: () => SecurityContext
  health: () => Health
  /** Jeton d'API, remis au dashboard par `/ui/bootstrap`. */
  token: () => string
  /** Délai maximal d'un long-poll, borne supérieure imposée au client. */
  maxWaitMs: number
  log: (...a: unknown[]) => void
  /** Repousse l'arrêt pour inactivité. */
  touch: () => void
  /** Demande l'arrêt du daemon (route `/api/shutdown`). */
  shutdown: (reason: string) => void
}

/** Envoie une réponse JSON, sauf si la connexion est déjà close — cas normal
 * d'un long-poll dont le client est parti. */
function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/**
 * Lit et parse un corps JSON, en coupant au-delà de `MAX_BODY_BYTES`.
 * @returns l'objet parsé, ou `{}` pour un corps vide
 * @throws sur corps trop gros ou JSON invalide (transformé en 400 par le routeur)
 */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Error('corps de requête trop volumineux')
    chunks.push(c as Buffer)
  }
  return chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {}
}

/** Construit le gestionnaire de requêtes du daemon. */
export function createRequestHandler(deps: HttpDeps) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ctx = deps.security()
    try {
      const denial = checkEnvelope(req, ctx)
      if (denial) return send(res, denial.status, { error: denial.error })

      const url = new URL(req.url ?? '/', `http://127.0.0.1:${ctx.port}`)
      const method = req.method ?? 'GET'

      // --- Dashboard : pas de jeton, l'enveloppe fait la sécurité -----------
      if (url.pathname === '/ui/bootstrap') {
        if (method !== 'GET') return send(res, 405, { error: 'method_not_allowed' })
        deps.touch()
        return send(res, 200, { token: deps.token(), health: deps.health() })
      }
      if (!url.pathname.startsWith('/api/')) {
        if (method !== 'GET' && method !== 'HEAD') return send(res, 405, { error: 'method_not_allowed' })
        return deps.files.serve(url.pathname, res)
      }

      // --- API : jeton obligatoire -----------------------------------------
      const unauthorized = checkToken(req, ctx)
      if (unauthorized) return send(res, unauthorized.status, { error: unauthorized.error })
      deps.touch()

      const parts = url.pathname.split('/').filter(Boolean) // ['api', …]
      const section = parts[1]
      const id = parts[2]
      const action = parts[3]

      if (section === 'health' && method === 'GET') return send(res, 200, deps.health())

      if (section === 'shutdown' && method === 'POST') {
        send(res, 200, { ok: true })
        return deps.shutdown('requête /api/shutdown')
      }

      if (section === 'approvals') return handleApprovals(deps, res, method, id, action, req)
      if (section === 'tasks') return handleTasks(deps, res, method, url, id, action, req)

      return send(res, 404, { error: 'not_found' })
    } catch (e) {
      deps.log('erreur de requête', e)
      return send(res, 400, { error: 'bad_request', detail: (e as Error).message })
    }
  }
}

/** Routes `/api/tasks…`. */
async function handleTasks(
  deps: HttpDeps,
  res: ServerResponse,
  method: string,
  url: URL,
  id: string | undefined,
  action: string | undefined,
  req: IncomingMessage,
): Promise<void> {
  if (!id) {
    if (method === 'POST') {
      // Le serveur MCP valide déjà ces bornes ; le daemon revérifie, car il ne
      // doit jamais faire confiance à un client, même local.
      const parsed = createTaskRequestSchema.safeParse(await readJson(req))
      if (!parsed.success) {
        return send(res, 400, { error: 'invalid_request', detail: parsed.error.issues })
      }
      const task = deps.tasks.create({
        objective: parsed.data.objective.trim(),
        durationS: parsed.data.duration_s,
        needsApproval: parsed.data.needs_approval,
      })
      return send(res, 201, deps.tasks.view(task))
    }
    if (method === 'GET') {
      const status = url.searchParams.get('status') ?? undefined
      const limit = Number(url.searchParams.get('limit') ?? 200)
      return send(res, 200, {
        tasks: deps.store.listTasks({
          ...(status ? { status: status as never } : {}),
          limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 500) : 200,
        }),
      })
    }
    return send(res, 405, { error: 'method_not_allowed' })
  }

  const view = deps.tasks.viewOf(id)
  if (!view) return send(res, 404, { error: 'task_not_found' })

  if (method === 'GET' && !action) return send(res, 200, view)
  if (method === 'GET' && action === 'events') return send(res, 200, { events: deps.tasks.events(id) })

  if (method === 'GET' && action === 'wait') {
    const asked = Number(url.searchParams.get('timeout_ms') ?? 25_000)
    const timeoutMs = Math.min(Math.max(Number.isFinite(asked) ? asked : 25_000, 0), deps.maxWaitMs)
    // `0` par défaut : sans information du client, toute pause est nouvelle pour lui.
    const known = Math.max(Number(url.searchParams.get('known_approval') ?? 0) || 0, 0)

    // `res` et non `req` : `req` émet 'close' dès que le corps est lu, alors que
    // `res` ne l'émet qu'à la fin de la réponse ou quand le client coupe.
    const aborter = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) aborter.abort()
    })
    const result = await deps.tasks.wait(id, timeoutMs, known, aborter.signal)
    if (!result) return send(res, 404, { error: 'task_not_found' })
    return send(res, 200, result)
  }

  if (method === 'POST' && action === 'cancel') {
    const body = await readJson(req).catch(() => ({}) as Record<string, unknown>)
    const reason = typeof body.reason === 'string' ? body.reason : undefined
    const outcome = deps.tasks.cancel(id, reason)
    if ('error' in outcome) return send(res, outcome.status, { error: outcome.error, ...outcome.detail })
    return send(res, 200, outcome)
  }

  return send(res, 405, { error: 'method_not_allowed' })
}

/** Routes `/api/approvals…`. Seul un humain les appelle : ni le serveur MCP, ni le modèle. */
async function handleApprovals(
  deps: HttpDeps,
  res: ServerResponse,
  method: string,
  id: string | undefined,
  action: string | undefined,
  req: IncomingMessage,
): Promise<void> {
  if (!id) {
    if (method !== 'GET') return send(res, 405, { error: 'method_not_allowed' })
    return send(res, 200, { approvals: deps.store.pendingApprovals() })
  }
  if (method !== 'POST' || (action !== 'approve' && action !== 'reject')) {
    return send(res, 405, { error: 'method_not_allowed' })
  }
  const body = await readJson(req).catch(() => ({}) as Record<string, unknown>)
  const by = typeof body.by === 'string' && body.by ? body.by : 'cli'
  const reason = typeof body.reason === 'string' ? body.reason : undefined
  const outcome = action === 'approve' ? deps.tasks.approve(id, by) : deps.tasks.reject(id, by, reason)
  if ('error' in outcome) return send(res, outcome.status, { error: outcome.error, ...outcome.detail })
  return send(res, 200, outcome)
}
