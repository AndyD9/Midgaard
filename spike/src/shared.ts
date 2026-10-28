/**
 * @file Contrat partagé entre le daemon, le serveur MCP, la CLI d'approbation et les tests.
 *
 * Ce module ne contient aucun effet de bord au chargement : il définit
 *  - où vit l'état runtime (fichier de découverte, verrou, journal) ;
 *  - le modèle de tâche et sa machine à états simplifiée ;
 *  - la traduction d'un état de tâche en consigne pour Claude (`NextAction`) ;
 *  - le client HTTP authentifié vers le daemon.
 *
 * Architecture du spike :
 *
 *   Claude Code ──stdio──► mcp-server.ts ──HTTP 127.0.0.1 + jeton──► daemon.ts
 *                                 └───────── lisent tous deux ─────────┘
 *                                       RUNTIME_FILE (port + jeton)
 *
 * ⚠️ Les chemins ci-dessous sont figés à l'évaluation du module. Pour changer
 * `MIDGAARD_HOME` (cas des tests), il faut le poser *avant* le premier import —
 * voir l'import dynamique dans `test/long-wait.ts`. En Slice 1, la configuration
 * sera injectée explicitement plutôt que lue au niveau module.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// --- Emplacements ----------------------------------------------------------

/** Racine du projet spike (le dossier qui contient `package.json`). */
export const SPIKE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Dossier d'état runtime. Par défaut dans le projet (`.runtime/`, ignoré par Git)
 * pour que le spike n'écrive rien ailleurs sur la machine ; la version distribuée
 * utilisera un dossier utilisateur. Surchargeable avec la variable `MIDGAARD_HOME`.
 */
export const HOME = process.env.MIDGAARD_HOME ?? join(SPIKE_ROOT, '.runtime')

/**
 * Fichier de découverte du daemon : port d'écoute, jeton d'accès et pid.
 * C'est par lui que le serveur MCP trouve le daemon. Écrit en `0600` car il
 * contient le jeton : quiconque le lit peut piloter le daemon.
 */
export const RUNTIME_FILE = join(HOME, 'daemon.json')

/** Verrou d'instance unique. Contient le pid du daemon qui le détient. */
export const LOCK_FILE = join(HOME, 'daemon.lock')

/** Journal du daemon quand il est lancé en arrière-plan par le serveur MCP. */
export const LOG_FILE = join(HOME, 'daemon.log')

/** Point d'entrée exécuté pour démarrer un daemon. */
export const DAEMON_ENTRY = join(SPIKE_ROOT, 'src', 'daemon.ts')

/**
 * Version du protocole entre serveur MCP et daemon, annoncée par `/health`.
 *
 * Le daemon tourne indéfiniment et survit donc aux mises à jour du code : un
 * serveur MCP récent peut tomber sur un daemon ancien, dont il ne comprend plus
 * les réponses. Un serveur MCP qui trouve une autre version remplace le daemon
 * (voir `ensureDaemon` dans `mcp-server.ts`).
 *
 * À incrémenter à chaque changement incompatible de l'API HTTP ou du modèle de tâche.
 *  - 1 : version initiale (pas de champ `protocol` dans `/health`) ;
 *  - 2 : pauses d'approbation numérotées (`approval_seq`, paramètre `known_approval`).
 */
export const PROTOCOL_VERSION = 2

// --- Modèle de tâche -------------------------------------------------------

/** Statuts finaux : une tâche qui y entre n'en sort plus. */
export const TERMINAL = ['completed', 'failed', 'cancelled'] as const

/**
 * Cycle de vie d'une tâche dans le spike :
 * `queued → running ⇄ waiting_approval → completed`, avec sortie possible vers
 * `cancelled` (annulation explicite) ou `failed`. La Slice 1 ajoutera `preparing`,
 * `timed_out`, `budget_exceeded` et `interrupted` (tâche trouvée en cours au
 * redémarrage du daemon).
 */
export type TaskStatus = 'queued' | 'running' | 'waiting_approval' | (typeof TERMINAL)[number]

/** Une tâche déléguée, telle que le daemon la stocke et l'expose. */
export interface Task {
  /** Identifiant UUID v4, renvoyé à Claude par `harness_delegate_task`. */
  id: string
  /** Ce que l'exécutant doit accomplir, en langage naturel. */
  objective: string
  status: TaskStatus
  /** Étape courante (0 = pas encore démarrée). Les tâches du spike sont simulées. */
  step: number
  steps_total: number
  /** Vrai tant qu'une étape exige encore une approbation humaine. */
  needs_approval: boolean
  /**
   * Numéro de la dernière pause d'approbation : 0 tant qu'il n'y en a eu aucune,
   * incrémenté à chaque entrée en `waiting_approval`. Permet de distinguer une
   * pause déjà signalée à Claude d'une nouvelle (voir {@link isActionable}).
   */
  approval_seq: number
  /** Horodatages ISO 8601. */
  created_at: string
  updated_at: string
  /** Présent uniquement quand la tâche est `completed`. */
  result?: { summary: string }
}

/**
 * Consigne renvoyée à Claude avec chaque état de tâche, pour qu'il sache quoi
 * faire sans interpréter le statut lui-même :
 *  - `result_ready` : le résultat est joint, la tâche est finie ;
 *  - `call_wait_for_task_again` : toujours en cours, rappeler `harness_wait_for_task` ;
 *  - `human_approval_pending` : **nouvelle** pause d'approbation — Claude doit
 *    prévenir l'utilisateur, jamais tenter d'approuver ;
 *  - `still_waiting_for_human` : pause déjà signalée, l'humain n'a pas encore
 *    décidé. Produite uniquement par le serveur MCP, qui sait ce qu'il a déjà dit
 *    à son client ; le daemon ne la renvoie jamais ;
 *  - `task_ended_without_result` : finie sans résultat (annulée, échouée).
 */
export type NextAction =
  | 'result_ready'
  | 'call_wait_for_task_again'
  | 'human_approval_pending'
  | 'still_waiting_for_human'
  | 'task_ended_without_result'

/** Contenu du fichier de découverte `RUNTIME_FILE`. */
export interface RuntimeInfo {
  pid: number
  /** Port choisi par le système au démarrage (aucun port fixe dans le spike). */
  port: number
  /** Jeton aléatoire de 256 bits, régénéré à chaque démarrage du daemon. */
  token: string
  started_at: string
}

/** Indique si un statut est final (voir {@link TERMINAL}). */
export function isTerminal(s: TaskStatus): boolean {
  return (TERMINAL as readonly string[]).includes(s)
}

/**
 * Traduit l'état d'une tâche en consigne pour Claude.
 * C'est aussi le critère d'arrêt du long-poll : on rend la main dès que la
 * consigne n'est plus `call_wait_for_task_again`.
 */
export function nextActionFor(t: Task): NextAction {
  if (t.status === 'completed') return 'result_ready'
  if (t.status === 'waiting_approval') return 'human_approval_pending'
  if (isTerminal(t.status)) return 'task_ended_without_result'
  return 'call_wait_for_task_again'
}

/**
 * Indique si l'état d'une tâche mérite d'interrompre une attente.
 *
 * Une fin de tâche l'est toujours. Une pause d'approbation ne l'est que si elle
 * est **plus récente** que la dernière déjà signalée au client (`knownApproval`).
 * Sans cette règle, rappeler l'attente sur une tâche déjà en pause rendait la
 * main aussitôt avec la même réponse : le client renonçait à attendre la décision
 * humaine, ou bouclait (défaut n° 2 du test réel, voir RESULTS.md).
 *
 * @param knownApproval numéro de la dernière pause déjà signalée ; 0 si aucune
 */
export function isActionable(t: Task, knownApproval = 0): boolean {
  const action = nextActionFor(t)
  if (action === 'call_wait_for_task_again') return false
  if (action === 'human_approval_pending') return t.approval_seq > knownApproval
  return true
}

// --- Fichier de découverte -------------------------------------------------

/**
 * Lit le fichier de découverte.
 * @returns les informations du daemon, ou `null` si le fichier est absent ou illisible.
 * Un résultat non nul ne garantit pas que le daemon tourne encore : le fichier
 * peut survivre à un `SIGKILL`. Toujours confirmer par un appel `/health`.
 */
export function readRuntime(): RuntimeInfo | null {
  try {
    return JSON.parse(readFileSync(RUNTIME_FILE, 'utf8')) as RuntimeInfo
  } catch {
    return null
  }
}

/**
 * Écrit le fichier de découverte de façon atomique (fichier temporaire puis
 * `rename`) : un serveur MCP qui le lit au même instant ne voit jamais un JSON
 * à moitié écrit. Dossier en `0700`, fichier en `0600`.
 */
export function writeRuntime(info: RuntimeInfo): void {
  mkdirSync(HOME, { recursive: true, mode: 0o700 })
  const tmp = `${RUNTIME_FILE}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(info, null, 2), { mode: 0o600 })
  renameSync(tmp, RUNTIME_FILE)
}

/**
 * Indique si un processus existe, sans lui envoyer de vrai signal (signal 0).
 * Sert à distinguer un verrou détenu d'un verrou périmé laissé par un daemon tué.
 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM : le process existe mais appartient à un autre utilisateur.
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// --- Client HTTP -----------------------------------------------------------

/**
 * Appelle l'API du daemon avec le jeton d'accès.
 * Passe toujours par `127.0.0.1` (jamais `localhost`, qui peut résoudre en IPv6
 * alors que le daemon n'écoute qu'en IPv4).
 * @param rt   informations lues par {@link readRuntime}
 * @param path chemin de l'API, par exemple `/tasks/<id>/wait?timeout_ms=15000`
 * @param init options `fetch` ; `signal` permet d'interrompre un long-poll
 * @throws si le daemon est injoignable (erreur réseau de `fetch`)
 */
export async function daemonFetch(rt: RuntimeInfo, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${rt.port}${path}`, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${rt.token}`, 'content-type': 'application/json' },
  })
}
