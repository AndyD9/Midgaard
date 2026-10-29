/**
 * @file Accès au daemon depuis le serveur MCP : le trouver, le démarrer s'il
 * n'est pas là, le remplacer s'il est d'une autre version.
 *
 * Le daemon survit aux sessions Claude Code. Trois situations à distinguer, et
 * une seule façon de les trancher : l'interroger.
 *
 *  - il répond avec **notre** version de protocole → on l'utilise ;
 *  - il répond avec une **autre** version (le code a été mis à jour pendant qu'il
 *    tournait) → on l'arrête et on en démarre un neuf. Sans ça, un serveur MCP
 *    récent dialoguerait avec un daemon périmé : en Slice 0, c'est exactement ce
 *    qui a fait qu'une pause d'approbation n'a jamais été signalée ;
 *  - il ne répond pas → on en démarre un.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, openSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import {
  PROTOCOL_VERSION,
  daemonFetch,
  pidAlive,
  readRuntime,
  type HarnessConfig,
  type RuntimeInfo,
} from '@midgaard/contracts'

/** Délai maximal accordé à un daemon fraîchement lancé pour devenir joignable. */
const BOOT_MS = 8_000
/** Délai maximal accordé à un daemon d'une autre version pour s'arrêter. */
const STOP_MS = 3_000
/** Délai d'un appel de diagnostic `/api/health`. */
const PROBE_MS = 1_000

/**
 * Résout le point d'entrée du daemon et les arguments de son lancement.
 *
 * `import.meta.resolve` suit les conditions d'export du processus courant : en
 * développement il rend le `.ts` de `src/`, une fois compilé le `.js` de `dist/`.
 * Le processus fils doit hériter de la même condition, sinon il résoudrait ses
 * propres imports vers l'autre variante.
 */
function daemonCommand(): { args: string[] } {
  const entry = fileURLToPath(import.meta.resolve('@midgaard/daemon/main'))
  // Les conditions personnalisées ne sont pas héritées par un process enfant :
  // on les repose explicitement quand on tourne depuis les sources.
  return { args: entry.endsWith('.ts') ? ['--conditions=midgaard-dev', entry] : [entry] }
}

/** État d'un daemon interrogé. */
type Probe = 'ok' | 'outdated' | 'down'

/**
 * Interroge le daemon décrit par `rt`.
 * @returns `ok` s'il répond avec notre version, `outdated` avec une autre,
 *          `down` s'il ne répond pas
 */
async function probe(rt: RuntimeInfo): Promise<Probe> {
  try {
    const r = await daemonFetch(rt, '/api/health', { signal: AbortSignal.timeout(PROBE_MS) })
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
async function retire(rt: RuntimeInfo, log: (...a: unknown[]) => void): Promise<void> {
  log(`daemon d'une autre version (pid ${rt.pid}), remplacement`)
  await daemonFetch(rt, '/api/shutdown', { method: 'POST', signal: AbortSignal.timeout(PROBE_MS) }).catch(() => {})
  const deadline = Date.now() + STOP_MS
  while (pidAlive(rt.pid) && Date.now() < deadline) await sleep(50)
}

/**
 * Renvoie un daemon joignable, en le démarrant si nécessaire.
 *
 * Le daemon est lancé **détaché** : il doit survivre à la fin de cette session
 * Claude Code, puisqu'il porte les tâches des autres sessions. Si plusieurs
 * serveurs MCP le lancent en même temps, son verrou garantit qu'un seul survit,
 * et tous finissent par lire le même fichier de découverte.
 *
 * @throws si aucun daemon ne répond après `BOOT_MS`
 */
export async function ensureDaemon(config: HarnessConfig, log: (...a: unknown[]) => void): Promise<RuntimeInfo> {
  const current = readRuntime(config.runtimeFile)
  const state = current ? await probe(current) : 'down'
  if (state === 'ok') return current!
  if (state === 'outdated') await retire(current!, log)

  log('daemon absent, démarrage')
  mkdirSync(config.home, { recursive: true, mode: 0o700 })
  const out = openSync(config.logFile, 'a', 0o600)
  const { args } = daemonCommand()
  // stdin ignoré, sorties vers le journal : surtout pas notre stdout, qui est le
  // canal JSON-RPC avec Claude Code.
  spawn(process.execPath, args, { detached: true, stdio: ['ignore', out, out], env: process.env }).unref()

  const deadline = Date.now() + BOOT_MS
  while (Date.now() < deadline) {
    await sleep(100)
    const rt = readRuntime(config.runtimeFile)
    // `rt.pid !== current?.pid` : ignorer un fichier de découverte périmé laissé
    // par le daemon qu'on vient de remplacer.
    if (rt && rt.pid !== current?.pid && (await probe(rt)) === 'ok') return rt
  }
  throw new Error(`le daemon n'a pas démarré en ${BOOT_MS} ms (voir ${config.logFile})`)
}

/**
 * Appelle le daemon et parse sa réponse JSON.
 *
 * Relit le fichier de découverte à chaque appel : port et jeton changent si le
 * daemon redémarre. En cas d'erreur réseau, retente **une fois** après avoir
 * relancé le daemon — le cas d'un daemon tué en cours de session. Aucune nouvelle
 * tentative si l'appel a été interrompu volontairement par le client.
 */
export async function callDaemon<T>(
  config: HarnessConfig,
  log: (...a: unknown[]) => void,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  let rt = await ensureDaemon(config, log)
  let res: Response
  try {
    res = await daemonFetch(rt, path, init)
  } catch (e) {
    if (init.signal?.aborted) throw e
    log('daemon injoignable, nouvelle tentative :', (e as Error).message)
    rt = await ensureDaemon(config, log)
    res = await daemonFetch(rt, path, init)
  }
  return { status: res.status, body: (await res.json()) as T }
}
