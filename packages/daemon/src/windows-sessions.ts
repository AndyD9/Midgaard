/**
 * @file Les sessions Windows des tâches (Slice 9, étape 5.3d) : brancher
 * l'outil `windows_run` (paquet `tools`) sur la VM d'un profil (5.3a) et le
 * dossier de tâche du paquet `remote` (5.3b).
 *
 * Le paquet `remote` sait joindre un hôte épinglé et y copier des fichiers ;
 * l'outil sait ce qui s'approuve. Ce module fait le lien, et tient ce qui ne
 * regarde ni l'un ni l'autre :
 *
 *  - **une connexion par appel** (décision du 2026-11-10) : chaque `run`
 *    ouvre, recopie le worktree, lance le script, et ferme. Rien ne reste
 *    ouvert pendant qu'une approbation attend un humain, qui peut durer ;
 *  - **la clé reste au coffre** : lue à chaque connexion, jamais ailleurs ;
 *  - **le dossier de la tâche est effacé à la fin** (`endTask`), sous sa
 *    racine permise, sans jamais suivre un lien (`remote`) ;
 *  - **rien de `.git`** ne part sur la VM ; les échantillons n'y sont pas non
 *    plus — ils vivent sous `samplesDir`, hors du worktree, donc hors de
 *    l'arbre copié (docs/SLICE9.md, décisions 9 et 12).
 *
 * Ce que Windows fait des processus d'une session coupée reste à constater sur
 * un vrai Windows (sous-étape 5.4) : ce module ferme la connexion, il ne
 * prétend pas tuer ce qu'elle a lancé.
 */
import type { HarnessConfig } from '@midgaard/contracts'
import {
  RemoteError,
  RemoteSession,
  powershellCommand,
  remoteTaskDir,
  type RemoteSession as RemoteSessionType,
  type RemoteTarget,
} from '@midgaard/remote'
import type { HarnessStore } from '@midgaard/persistence'
import type { SecretVault } from '@midgaard/secrets'
import { ToolError, type WindowsPort, type WindowsRunOutcome, type WindowsTarget } from '@midgaard/tools'
import { windowsKeyRef } from './windows-hosts.ts'

/** Ce dont les sessions ont besoin : le même socle que le service des VM. */
export interface WindowsSessionsDeps {
  store: HarnessStore
  config: Pick<HarnessConfig, 'home'>
  vault: SecretVault
  log: (...a: unknown[]) => void
  /**
   * Ouvre une session vers un hôte épinglé. Par défaut `RemoteSession.open` ;
   * les tests passent la leur pour viser l'hôte factice.
   */
  openSession?: ((target: RemoteTarget) => Promise<RemoteSessionType>) | undefined
}

/** Délai de connexion d'un `run`, poignée de main comprise. */
export const WINDOWS_RUN_CONNECT_MS = 15_000
/** Délai du nettoyage de fin de tâche : court, c'est au mieux. */
export const WINDOWS_CLEANUP_MS = 30_000

/** Ce qu'une tâche vise sur la VM, noté à l'ouverture du port pour le nettoyage. */
interface Registered {
  hostId: string
  worktree: string
}

/**
 * Convertit un chemin SFTP (`/C:/Users/x/...`) en chemin Windows
 * (`C:\\Users\\x\\...`), pour `Set-Location` : le script tourne dans le dossier
 * `work`, et référence ses fichiers en relatif.
 */
export function windowsPathOf(sftpPath: string): string {
  return sftpPath.replace(/^\/([A-Za-z]):/, '$1:').replace(/\//g, '\\')
}

/**
 * N'exclut de la copie que `.git` : le reste du worktree part sur la VM. Les
 * échantillons ne sont pas dans le worktree (ils vivent sous `samplesDir`),
 * donc ils ne sont jamais ici.
 */
export function worktreeUploadExclude(rel: string): string | null {
  return rel === '.git' || rel.startsWith('.git/') ? 'never copied: .git' : null
}

/** Les sessions Windows de toutes les tâches du daemon. */
export class WindowsSessions {
  private readonly deps: WindowsSessionsDeps
  /** Ce que chaque tâche vise, pour le nettoyage de fin. */
  private readonly registered = new Map<string, Registered>()
  private stopped = false

  constructor(deps: WindowsSessionsDeps) {
    this.deps = deps
  }

  /**
   * Le port d'une tâche : ce que `windows_run` peut faire de sa VM.
   *
   * @param hostId   la VM attachée au profil
   * @param worktree le worktree de la tâche, recopié avant chaque script
   * @param redact   l'expurgation de la tâche, pour le journal
   */
  portFor(taskId: string, hostId: string, worktree: string, redact: (text: string) => string): WindowsPort {
    this.registered.set(taskId, { hostId, worktree })
    return {
      target: () => this.targetOf(hostId),
      run: (script, options) => this.run(taskId, hostId, worktree, script, options, redact),
    }
  }

  /** La VM telle que la base la décrit **maintenant** ; `null` si elle a disparu. */
  private targetOf(hostId: string): WindowsTarget | null {
    const host = this.deps.store.getWindowsHost(hostId)
    if (!host) return null
    return { id: host.id, address: host.host, port: host.port, username: host.username, fingerprint: host.fingerprint }
  }

  /**
   * Ouvre une connexion, recopie le worktree, lance le script, ferme.
   *
   * @throws {ToolError} VM disparue, clé absente, hôte injoignable ou qui
   *         présente une autre empreinte, copie refusée : rien n'a tourné
   */
  private async run(
    taskId: string,
    hostId: string,
    worktree: string,
    script: string,
    options: { timeoutMs: number; signal?: AbortSignal | undefined; onOutput?: ((stream: 'stdout' | 'stderr', chunk: Buffer) => void) | undefined },
    redact: (text: string) => string,
  ): Promise<WindowsRunOutcome> {
    const session = await this.connect(hostId)
    try {
      const where = remoteTaskDir(await session.homeDir(), taskId)
      const copied = await session.replaceTree(worktree, where.work, where.base, worktreeUploadExclude)
      // Le script tourne dans `work`, où le worktree vient d'être recopié : il
      // référence ses fichiers en relatif, sans connaître le chemin de la VM.
      const wrapped = `Set-Location -LiteralPath '${windowsPathOf(where.work)}'\n${script}`
      this.deps.log(`tâche ${taskId.slice(0, 8)} : windows_run sur « ${hostId} », worktree recopié (${copied.files} fichiers)`)
      const r = await session.run(powershellCommand(wrapped), options)
      return {
        code: r.code,
        stdout: r.stdout,
        stderr: r.stderr,
        stdoutBytes: r.stdoutBytes,
        stderrBytes: r.stderrBytes,
        timedOut: r.timedOut,
        cancelled: r.cancelled,
        durationMs: r.durationMs,
        copied: { files: copied.files, bytes: copied.bytes, skipped: copied.skipped.length },
      }
    } catch (e) {
      // Les messages de `remote` sont en anglais et lisibles par le modèle ;
      // on les expurge comme tout ce qui lui remonte (un chemin peut nommer l'utilisateur).
      throw new ToolError(redact(e instanceof RemoteError ? e.message : (e as Error).message))
    } finally {
      session.close()
    }
  }

  /** Ouvre une session vers la VM épinglée, clé lue au coffre. */
  private async connect(hostId: string): Promise<RemoteSessionType> {
    const host = this.deps.store.getWindowsHost(hostId)
    if (!host) throw new ToolError(`the Windows VM "${hostId}" is no longer declared`)
    const privateKey = await this.deps.vault.get(await windowsKeyRef(this.deps.config.home, hostId)).catch(() => null)
    if (!privateKey) {
      throw new ToolError(`no key for the Windows VM "${hostId}" in the vault: redeclare it with a new key and install it`)
    }
    const open = this.deps.openSession ?? RemoteSession.open
    return open({
      host: host.host,
      port: host.port,
      username: host.username,
      privateKey,
      fingerprint: host.fingerprint,
      connectTimeoutMs: WINDOWS_RUN_CONNECT_MS,
    })
  }

  /**
   * La tâche s'arrête : son dossier sur la VM est effacé. Au mieux — une VM
   * éteinte ne doit pas empêcher la tâche de se conclure —, journalisé, ne
   * lève jamais. Aucune session ne survit, chacune se ferme à son `run`.
   */
  async endTask(taskId: string): Promise<void> {
    const reg = this.registered.get(taskId)
    this.registered.delete(taskId)
    if (!reg || this.stopped) return
    let session: RemoteSessionType
    try {
      session = await this.connect(reg.hostId)
    } catch (e) {
      // VM éteinte ou retirée : rien à nettoyer qu'on puisse joindre.
      this.deps.log(`tâche ${taskId.slice(0, 8)} : dossier VM non effacé (${(e as Error).message})`)
      return
    }
    try {
      const where = remoteTaskDir(await session.homeDir(), taskId)
      const summary = await session.removeTree(where.dir, where.base)
      this.deps.log(`tâche ${taskId.slice(0, 8)} : dossier VM effacé (${summary.removed} entrées)`)
    } catch (e) {
      this.deps.log(`tâche ${taskId.slice(0, 8)} : dossier VM non effacé (${(e as Error).message})`)
    } finally {
      session.close()
    }
  }

  /** Le daemon s'arrête : on ne nettoie plus rien à distance (les tâches deviennent interrupted). */
  closeAll(): void {
    this.stopped = true
    this.registered.clear()
  }
}
