/**
 * @file Daemon du harness : la source de vérité unique des tâches.
 *
 * Un seul daemon tourne par dossier runtime, quel que soit le nombre de sessions
 * Claude Code ouvertes. Chaque session lance son propre serveur MCP (stdio), et
 * tous ces serveurs relaient vers ce daemon en HTTP. C'est lui qui détient l'état,
 * fait avancer les tâches et réveille ceux qui attendent.
 *
 * L'unicité repose sur un fichier verrou, en deux temps :
 *  1. au démarrage, création atomique du verrou (contenu compris) ;
 *  2. ensuite, un bail vérifié toutes les `LEASE_MS` : le daemon qui ne lit plus
 *     son propre pid dans le verrou a perdu une course et s'arrête.
 * Le 2 rattrape les courses que le 1 ne peut pas exclure seul (récupération
 * simultanée d'un verrou périmé). Voir `test/single-instance.ts`.
 *
 * Dans le spike, les tâches sont **factices** : `STEPS_TOTAL` étapes minutées, avec
 * éventuellement une pause pour approbation. On valide la plomberie (découverte,
 * authentification, long-poll, annulation), pas les agents (Slice 2).
 * L'état est **en mémoire** : il est perdu au redémarrage (SQLite en Slice 1).
 *
 * API HTTP, liée à 127.0.0.1 uniquement. Toute requête exige le jeton
 * (`Authorization: Bearer …`), un `Host` loopback exact et aucune `Origin` :
 *
 * | Méthode | Chemin                    | Rôle                                                  | Codes          |
 * |---------|---------------------------|-------------------------------------------------------|----------------|
 * | GET     | /health                   | Vivacité, pid, version de protocole, uptime, tâches   | 200            |
 * | POST    | /tasks                    | Crée une tâche `{objective, duration_s, needs_approval}` | 201, 400    |
 * | GET     | /tasks[?status=…]         | Liste les tâches, filtrées par statut si demandé      | 200            |
 * | GET     | /tasks/:id                | État d'une tâche et sa `next_action`                  | 200, 404       |
 * | GET     | /tasks/:id/wait           | Long-poll (max 60 s) jusqu'à un état actionnable ;    | 200, 404       |
 * |         |   ?timeout_ms&known_approval | une pause n° ≤ `known_approval` ne l'est pas        |                |
 * | POST    | /tasks/:id/approve        | Approbation humaine d'une tâche en attente            | 200, 404, 409  |
 * | POST    | /tasks/:id/cancel         | Annulation explicite                                  | 200, 404, 409  |
 * | POST    | /shutdown                 | Arrêt propre (utilisé par les tests)                  | 200            |
 *
 * Erreurs communes : 401 sans jeton valide, 403 sur `Host`/`Origin` refusés,
 * 400 sur corps invalide ou trop gros, 405 sur méthode inconnue.
 *
 * Variables d'environnement : `MIDGAARD_HOME` (dossier runtime, voir `shared.ts`),
 * `MIDGAARD_PORT` (port fixe ; par défaut le système en choisit un libre).
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  HOME, LOCK_FILE, PROTOCOL_VERSION, RUNTIME_FILE, isActionable, isTerminal, nextActionFor, pidAlive, readRuntime, writeRuntime,
  type Task,
} from './shared.ts'

/** Nombre d'étapes d'une tâche simulée. */
const STEPS_TOTAL = 5
/** Étape à laquelle une tâche `needs_approval` se met en pause. */
const APPROVAL_STEP = 3
/**
 * Durée maximale d'un long-poll. Volontairement courte : c'est au serveur MCP
 * d'enchaîner les tranches (et d'émettre des notifications de progression entre
 * elles), pas au daemon de tenir une connexion des minutes durant.
 */
const MAX_WAIT_MS = 60_000
/** Taille maximale d'un corps de requête, contre l'épuisement mémoire. */
const MAX_BODY_BYTES = 64 * 1024
/**
 * Intervalle de vérification du bail. C'est aussi le délai maximal pendant lequel
 * deux daemons peuvent coexister après une course perdue.
 */
const LEASE_MS = 1_000

/** Journalise sur stderr, redirigé vers `LOG_FILE` quand le daemon tourne en arrière-plan. */
const log = (...a: unknown[]) => console.error(new Date().toISOString(), '[daemon]', ...a)

// --- Instance unique -------------------------------------------------------

/**
 * Crée le verrou de façon atomique, **contenu compris**.
 *
 * Le pid est d'abord écrit dans un fichier temporaire privé, puis lié sous le nom
 * du verrou avec `link`, qui échoue si ce nom existe déjà. Un concurrent ne peut
 * donc jamais lire un verrou vide. (Avant ce correctif, le verrou était créé vide
 * puis rempli : un concurrent qui le lisait entre-temps le croyait périmé.)
 *
 * `link` exige un système de fichiers qui gère les liens physiques : APFS, ext4,
 * NTFS oui ; FAT/exFAT non.
 *
 * @returns `true` si le verrou a été créé, `false` s'il existait déjà
 */
function tryCreateLock(): boolean {
  const tmp = `${LOCK_FILE}.${process.pid}.tmp`
  writeFileSync(tmp, String(process.pid), { mode: 0o600 })
  try {
    linkSync(tmp, LOCK_FILE)
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw e
  } finally {
    unlinkSync(tmp)
  }
}

/**
 * Lit le pid inscrit dans le verrou.
 * @returns le pid, ou `null` si le verrou est absent ou illisible
 */
function readLockPid(): number | null {
  try {
    const pid = Number(readFileSync(LOCK_FILE, 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/**
 * Prend le verrou d'instance unique au démarrage.
 *
 * Si le verrou existe et que son détenteur est vivant, on renonce. S'il est
 * périmé (détenteur mort, typiquement après un `SIGKILL`), on le supprime et on
 * retente.
 *
 * ⚠️ Cette récupération n'est pas atomique : si plusieurs daemons trouvent le même
 * verrou périmé, l'un peut supprimer le verrou tout neuf d'un autre en le croyant
 * périmé, et les deux se croient détenteurs. Ce cas est résolu par le bail
 * ({@link checkLease}) : le dernier à avoir créé le verrou le garde, les autres
 * s'arrêtent dans la seconde.
 *
 * @returns `true` si ce processus détient le verrou
 */
function acquireLock(): boolean {
  mkdirSync(HOME, { recursive: true, mode: 0o700 })
  for (let attempt = 0; attempt < 3; attempt++) {
    if (tryCreateLock()) return true
    const holder = readLockPid()
    if (holder !== null && pidAlive(holder)) return false
    log(`verrou périmé (pid ${holder}), récupération`)
    try {
      unlinkSync(LOCK_FILE)
    } catch (e) {
      // ENOENT : un concurrent l'a déjà supprimé, on retente simplement.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
  }
  return false
}

// Sortie avec le code 0 : ce n'est pas une erreur, un autre daemon fait déjà le travail.
if (!acquireLock()) {
  log('un autre daemon détient le verrou, sortie')
  process.exit(0)
}

// --- État des tâches -------------------------------------------------------

/** Toutes les tâches connues, par identifiant. En mémoire seulement dans le spike. */
const tasks = new Map<string, Task>()
/** Minuteur de la prochaine étape de chaque tâche active. */
const timers = new Map<string, NodeJS.Timeout>()
/** Long-polls en attente sur chaque tâche, réveillés à chaque changement. */
const waiters = new Map<string, Set<() => void>>()
/** Durée d'une étape, par tâche (durée demandée ÷ nombre d'étapes). */
const intervals = new Map<string, number>()

/** Réveille tous les long-polls en attente sur une tâche ; chacun décide s'il répond. */
function notify(id: string): void {
  for (const w of waiters.get(id) ?? []) w()
}

/**
 * Seul point de mutation d'une tâche : applique le changement, met à jour
 * l'horodatage, journalise et réveille les attentes. Passer toujours par ici
 * garantit qu'aucun long-poll ne rate une transition.
 */
function update(t: Task, patch: Partial<Task>): void {
  Object.assign(t, patch, { updated_at: new Date().toISOString() })
  log(`tâche ${t.id.slice(0, 8)} -> ${t.status} (${t.step}/${t.steps_total})`)
  notify(t.id)
}

/** Programme la prochaine étape de la tâche. */
function schedule(t: Task): void {
  timers.set(t.id, setTimeout(() => tick(t), intervals.get(t.id)))
}

/**
 * Fait avancer une tâche simulée d'une étape.
 * S'arrête sans reprogrammer si la tâche est finie, en pause d'approbation,
 * ou vient d'atteindre sa dernière étape. Une tâche en pause n'est relancée
 * que par la route `/approve`.
 */
function tick(t: Task): void {
  timers.delete(t.id)
  // Garde-fou : une annulation a pu arriver entre la programmation et l'exécution.
  if (isTerminal(t.status) || t.status === 'waiting_approval') return
  const step = t.step + 1
  if (step >= t.steps_total) {
    update(t, { step, status: 'completed', result: { summary: `Tâche factice terminée : ${t.objective}` } })
    return
  }
  if (t.needs_approval && step === APPROVAL_STEP) {
    update(t, { step, status: 'waiting_approval', approval_seq: t.approval_seq + 1 })
    return
  }
  update(t, { step, status: 'running' })
  schedule(t)
}

/**
 * Crée une tâche simulée et programme sa première étape.
 * @param objective     description libre, renvoyée dans le résultat
 * @param durationS     durée totale simulée, en secondes (bornée par l'appelant)
 * @param needsApproval si vrai, la tâche se met en pause à `APPROVAL_STEP`
 */
function createTask(objective: string, durationS: number, needsApproval: boolean): Task {
  const now = new Date().toISOString()
  const t: Task = {
    id: randomUUID(), objective, status: 'queued', step: 0, steps_total: STEPS_TOTAL,
    needs_approval: needsApproval, approval_seq: 0, created_at: now, updated_at: now,
  }
  tasks.set(t.id, t)
  intervals.set(t.id, Math.round((durationS * 1000) / STEPS_TOTAL))
  log(`tâche ${t.id.slice(0, 8)} créée (${durationS}s, approbation=${needsApproval})`)
  schedule(t)
  return t
}

// --- HTTP ------------------------------------------------------------------

/** Jeton d'accès de 256 bits, régénéré à chaque démarrage et publié dans `RUNTIME_FILE`. */
const token = randomBytes(32).toString('hex')
/** En-tête `Authorization` attendu, précalculé pour la comparaison à temps constant. */
const tokenBuf = Buffer.from(`Bearer ${token}`)
/** Port réel, connu seulement après `listen` (le système le choisit). */
let port = 0

/**
 * Envoie une réponse JSON, sauf si la connexion est déjà fermée ou la réponse
 * déjà partie — cas normal pour un long-poll dont le client est parti.
 */
function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/**
 * Vérifie le jeton. `timingSafeEqual` évite qu'on puisse deviner le jeton octet
 * par octet en mesurant le temps de réponse ; il exige des tailles égales, d'où
 * la vérification de longueur préalable.
 */
function authorized(req: IncomingMessage): boolean {
  const got = Buffer.from(req.headers.authorization ?? '')
  return got.length === tokenBuf.length && timingSafeEqual(got, tokenBuf)
}

/**
 * Refuse les requêtes qui ne viennent pas d'un client local légitime.
 *
 * - **Host exact** : une page web malveillante peut faire pointer son propre nom
 *   de domaine vers 127.0.0.1 (DNS rebinding) ; le navigateur enverra alors ce
 *   nom dans `Host`, et on le rejette.
 * - **Aucune Origin** : les navigateurs ajoutent `Origin` aux requêtes
 *   inter-sites ; nos clients légitimes (serveur MCP, CLI) n'en envoient jamais.
 *   Le dashboard de la Slice 1 aura une origine en liste blanche.
 */
function trustedRequest(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false
  return req.headers.origin === undefined
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
    if (size > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(c as Buffer)
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

/**
 * Long-poll : répond dès que la tâche atteint un état « actionnable » pour Claude
 * (fin, ou **nouvelle** pause d'approbation), ou à l'expiration de `timeoutMs`.
 * La réponse contient toujours `next_action` et le temps réellement attendu.
 *
 * `knownApproval` est le numéro de la dernière pause déjà signalée au client :
 * une pause qui n'est pas plus récente n'interrompt pas l'attente, qui continue
 * jusqu'à la décision humaine (voir `isActionable` dans `shared.ts`).
 *
 * Trois issues possibles, chacune nettoie l'abonnement et le minuteur :
 *  1. changement d'état actionnable → réponse immédiate ;
 *  2. délai écoulé → réponse avec l'état courant (`call_wait_for_task_again`) ;
 *  3. client parti → rien à envoyer, simple nettoyage.
 */
function waitFor(t: Task, timeoutMs: number, knownApproval: number, res: ServerResponse): void {
  const started = Date.now()
  const reply = () => send(res, 200, { task: t, next_action: nextActionFor(t), waited_ms: Date.now() - started })
  if (isActionable(t, knownApproval)) return reply()

  const set = waiters.get(t.id) ?? new Set()
  waiters.set(t.id, set)
  // `cleanup` référence `timer`, déclaré plus bas : sans danger, car `cleanup` n'est
  // jamais appelé avant la création du minuteur (tout se déclenche de façon asynchrone).
  const cleanup = () => {
    clearTimeout(timer)
    set.delete(onChange)
  }
  const onChange = () => {
    if (!isActionable(t, knownApproval)) return
    cleanup()
    reply()
  }
  const timer = setTimeout(() => {
    cleanup()
    reply()
  }, timeoutMs)
  set.add(onChange)
  // `res` et non `req` : `req` émet 'close' dès que le corps est lu.
  // `res` émet 'close' à la fin de la réponse OU quand le client coupe la connexion ;
  // `writableFinished` distingue les deux.
  res.on('close', () => {
    if (!res.writableFinished) log(`long-poll ${t.id.slice(0, 8)} abandonné par le client`)
    cleanup()
  })
}

const startedAt = Date.now()

/**
 * Routeur. Les contrôles de sécurité passent avant tout le reste, y compris
 * avant de savoir si la route existe : un client non authentifié ne doit rien
 * apprendre de l'API.
 */
const server = createServer(async (req, res) => {
  try {
    if (!trustedRequest(req)) return send(res, 403, { error: 'forbidden_origin_or_host' })
    if (!authorized(req)) return send(res, 401, { error: 'unauthorized' })

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    const parts = url.pathname.split('/').filter(Boolean)

    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, {
        ok: true, pid: process.pid, protocol: PROTOCOL_VERSION,
        uptime_s: Math.round((Date.now() - startedAt) / 1000), tasks: tasks.size,
      })
    }

    if (req.method === 'POST' && url.pathname === '/tasks') {
      const body = await readJson(req)
      const objective = String(body.objective ?? '').trim()
      const durationS = Number(body.duration_s ?? 20)
      if (!objective) return send(res, 400, { error: 'objective_required' })
      // Le serveur MCP valide déjà ces bornes ; le daemon revérifie, car il ne doit
      // jamais faire confiance à un client, même local.
      if (!Number.isFinite(durationS) || durationS < 1 || durationS > 900) return send(res, 400, { error: 'duration_s_out_of_range' })
      return send(res, 201, createTask(objective, durationS, Boolean(body.needs_approval)))
    }

    if (req.method === 'POST' && url.pathname === '/shutdown') {
      send(res, 200, { ok: true })
      return shutdown('requête /shutdown')
    }

    if (req.method === 'GET' && url.pathname === '/tasks') {
      const status = url.searchParams.get('status')
      return send(res, 200, { tasks: [...tasks.values()].filter((t) => !status || t.status === status) })
    }

    // Toutes les routes restantes ont la forme /tasks/:id[/action].
    if (parts[0] !== 'tasks' || !parts[1]) return send(res, 404, { error: 'not_found' })
    const t = tasks.get(parts[1])
    if (!t) return send(res, 404, { error: 'task_not_found' })
    const action = parts[2]

    if (req.method === 'GET' && !action) return send(res, 200, { task: t, next_action: nextActionFor(t) })

    if (req.method === 'GET' && action === 'wait') {
      // Délai borné entre 0 et MAX_WAIT_MS ; 25 s si absent.
      const ms = Math.min(Math.max(Number(url.searchParams.get('timeout_ms') ?? 25_000), 0), MAX_WAIT_MS)
      // 0 par défaut : sans information du client, toute pause est nouvelle pour lui.
      const known = Math.max(Number(url.searchParams.get('known_approval') ?? 0) || 0, 0)
      return waitFor(t, ms, known, res)
    }

    if (req.method === 'POST' && action === 'approve') {
      // 409 si rien n'attend : une approbation ne s'applique qu'à une pause en cours,
      // jamais par anticipation.
      if (t.status !== 'waiting_approval') return send(res, 409, { error: 'not_waiting_approval', status: t.status })
      update(t, { status: 'running', needs_approval: false })
      schedule(t)
      return send(res, 200, { task: t })
    }

    if (req.method === 'POST' && action === 'cancel') {
      if (isTerminal(t.status)) return send(res, 409, { error: 'already_terminal', status: t.status })
      clearTimeout(timers.get(t.id))
      timers.delete(t.id)
      update(t, { status: 'cancelled' })
      return send(res, 200, { task: t })
    }

    return send(res, 405, { error: 'method_not_allowed' })
  } catch (e) {
    log('erreur requête', e)
    return send(res, 400, { error: 'bad_request', detail: (e as Error).message })
  }
})

/**
 * Vérifie le bail, toutes les `LEASE_MS`.
 *
 * - Le verrou désigne un autre daemon : on a perdu une course, on s'arrête. L'arrêt
 *   ne touche ni à son verrou ni à son fichier de découverte (voir {@link shutdown}).
 * - Le verrou a disparu (supprimé à la main, par exemple) : on le recrée si
 *   personne ne l'a fait, plutôt que de s'arrêter et perdre les tâches en cours.
 * - On est bien le détenteur mais le fichier de découverte ne nous désigne pas
 *   (un perdant l'a écrit en dernier, puis l'a supprimé en s'arrêtant) : on le
 *   republie, sinon les serveurs MCP ne nous trouveraient plus.
 */
function checkLease(): void {
  let holder = readLockPid()
  if (holder === null && tryCreateLock()) {
    log('verrou disparu, recréé')
    holder = process.pid
  }
  holder ??= readLockPid()
  if (holder !== process.pid) return shutdown(`verrou détenu par le pid ${holder ?? 'inconnu'}`)
  if (readRuntime()?.pid !== process.pid) {
    writeRuntime({ pid: process.pid, port, token, started_at: new Date(startedAt).toISOString() })
    log('fichier de découverte republié')
  }
}

let stopping = false

/**
 * Arrêt propre : coupe les minuteurs et les connexions (y compris les long-polls
 * en cours, sinon `server.close` attendrait leur fin), puis supprime le fichier de
 * découverte et le verrou pour qu'un prochain daemon démarre sans attendre.
 * Le verrou et le fichier de découverte ne sont supprimés que s'ils sont bien les
 * nôtres : un daemon qui s'arrête après avoir perdu une course ne doit pas
 * effacer ceux du gagnant.
 * Idempotent : un double signal ne déclenche qu'un seul arrêt.
 */
function shutdown(reason: string): void {
  if (stopping) return
  stopping = true
  log(`arrêt (${reason})`)
  for (const t of timers.values()) clearTimeout(t)
  server.closeAllConnections()
  server.close()
  try {
    if (readRuntime()?.pid === process.pid) unlinkSync(RUNTIME_FILE)
  } catch {}
  try {
    if (readLockPid() === process.pid) unlinkSync(LOCK_FILE)
  } catch {}
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

// Le fichier de découverte n'est écrit qu'une fois le port connu et le serveur
// prêt : un serveur MCP qui le lit peut appeler le daemon immédiatement.
server.listen(Number(process.env.MIDGAARD_PORT ?? 0), '127.0.0.1', () => {
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  writeRuntime({ pid: process.pid, port, token, started_at: new Date(startedAt).toISOString() })
  log(`à l'écoute sur 127.0.0.1:${port} (pid ${process.pid})`)
  // `unref` : le minuteur du bail ne doit pas, à lui seul, empêcher le processus de se terminer.
  setInterval(checkLease, LEASE_MS).unref()
})
