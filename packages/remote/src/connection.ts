/**
 * @file Une session SSH vers la VM Windows de test (Slice 9, étape 5).
 *
 * Ce que la session garantit :
 *
 *  1. **L'empreinte d'hôte est comparée avant toute authentification.** SSH
 *     vérifie l'hôte pendant l'échange de clés, avant que le client ne prouve
 *     quoi que ce soit : un hôte qui présente une autre clé n'apprend rien de
 *     la nôtre, ni même le nom d'utilisateur. Le refus dit l'empreinte vue,
 *     pour que l'humain la compare à celle de la console.
 *  2. **La clé ne quitte pas la mémoire** : elle vient du coffre, par
 *     l'appelant, et `ssh2` la lit telle quelle. Aucun fichier temporaire.
 *  3. **Une commande a un délai et s'annule** : au délai ou au signal, le
 *     canal est fermé et le résultat le dit (`timedOut`, `cancelled`). Ce que
 *     l'hôte fait alors des processus lancés est l'objet de la sous-étape
 *     5.4 : la session ne prétend pas les tuer.
 *  4. **Sortie bornée, début et fin conservés**, comme `exec` ; chaque
 *     morceau est aussi rendu à `onOutput`, pour la sortie en direct.
 *  5. **La copie ne suit jamais un lien** : un lien du worktree peut désigner
 *     `~/.ssh` ; il est écarté et nommé, jamais copié sur la VM.
 *
 * Ce module ne connaît ni le daemon, ni les approbations, ni PowerShell :
 * il transporte des commandes et des fichiers vers un hôte épinglé.
 */
import { lstat, readdir } from 'node:fs/promises'
import { join, posix, relative, sep } from 'node:path'
import ssh2 from 'ssh2'
import type { ClientChannel, SFTPWrapper, Stats } from 'ssh2'
import { fingerprintOf } from './keys.ts'
import { isStrictlyUnder } from './task-dir.ts'

/** Pourquoi une connexion a échoué. */
export type RemoteErrorKind = 'fingerprint_mismatch' | 'auth_failed' | 'unreachable' | 'timeout' | 'protocol'

/** Échec d'une connexion ou d'une copie, avec sa nature. Message en anglais : il remonte au modèle. */
export class RemoteError extends Error {
  readonly kind: RemoteErrorKind
  /** Empreinte présentée par l'hôte, quand c'est elle qui a été refusée. */
  readonly presented: string | null
  constructor(kind: RemoteErrorKind, message: string, presented: string | null = null) {
    super(message)
    this.name = 'RemoteError'
    this.kind = kind
    this.presented = presented
  }
}

/** Ce qu'il faut pour joindre un hôte épinglé. */
export interface RemoteTarget {
  host: string
  port: number
  username: string
  /** Clé privée OpenSSH, lue au coffre. */
  privateKey: string
  /** Empreinte épinglée, `SHA256:…`. */
  fingerprint: string
  /** Délai de connexion, poignée de main comprise. */
  connectTimeoutMs?: number | undefined
}

/** Résultat d'une commande. */
export interface RemoteRunResult {
  /** Code de sortie ; `null` si la commande n'a pas fini (délai, annulation, coupure). */
  code: number | null
  stdout: string
  stderr: string
  stdoutBytes: number
  stderrBytes: number
  timedOut: boolean
  cancelled: boolean
  durationMs: number
}

/** Options d'une commande. */
export interface RemoteRunOptions {
  timeoutMs: number
  signal?: AbortSignal | undefined
  /** Chaque morceau lu, brut, pour la sortie en direct. */
  onOutput?: ((stream: 'stdout' | 'stderr', chunk: Buffer) => void) | undefined
}

/** Bilan d'une copie d'arbre. */
export interface UploadSummary {
  files: number
  bytes: number
  /** Chemins relatifs écartés, avec leur motif (lien, type spécial, filtre). */
  skipped: { path: string; reason: string }[]
}

/** Bilan d'un effacement distant. */
export interface RemoveSummary {
  /** Fichiers et dossiers effacés, le dossier visé compris. */
  removed: number
  /** Liens retirés **eux-mêmes**, jamais parcourus, en chemins relatifs au dossier visé. */
  links: string[]
}

/**
 * Entrées au plus qu'un effacement parcourt. Plus large que la copie : les
 * commandes lancées sur la VM peuvent écrire dans le dossier de la tâche.
 * Au-delà, l'effacement s'arrête et le dit, plutôt que de tourner sans fin.
 */
export const REMOVE_MAX_ENTRIES = 100_000

/** Octets conservés au début et à la fin de chaque flux, comme `exec`. */
const HEAD = 8 * 1024
const TAIL = 32 * 1024

/** Bornes d'une copie : au-delà, refus — une VM de test n'est pas un miroir. */
export const UPLOAD_MAX_FILES = 20_000
export const UPLOAD_MAX_BYTES = 256 * 1024 * 1024

/** Garde le début et la fin d'un flux, et compte tout. */
class Bounded {
  private head: Buffer[] = []
  private headBytes = 0
  private tail: Buffer[] = []
  private tailBytes = 0
  bytes = 0
  write(chunk: Buffer): void {
    this.bytes += chunk.length
    if (this.headBytes < HEAD) {
      const take = chunk.subarray(0, HEAD - this.headBytes)
      this.head.push(take)
      this.headBytes += take.length
      chunk = chunk.subarray(take.length)
    }
    if (chunk.length === 0) return
    this.tail.push(chunk)
    this.tailBytes += chunk.length
    while (this.tailBytes - (this.tail[0]?.length ?? 0) >= TAIL) this.tailBytes -= this.tail.shift()!.length
  }
  text(): string {
    const head = Buffer.concat(this.head).toString('utf8')
    const tail = Buffer.concat(this.tail)
    const cut = this.bytes - this.headBytes - tail.length
    const kept = tail.subarray(Math.max(0, tail.length - TAIL)).toString('utf8')
    return cut > 0 ? `${head}\n[… ${cut} bytes omitted …]\n${kept}` : head + kept
  }
}

/** Une session ouverte vers un hôte épinglé. */
export class RemoteSession {
  private readonly client: ssh2.Client
  private sftpChannel: Promise<SFTPWrapper> | null = null
  private closed = false

  private constructor(client: ssh2.Client) {
    this.client = client
  }

  /**
   * Ouvre une session. L'empreinte est comparée pendant l'échange de clés,
   * avant toute authentification.
   *
   * @throws {RemoteError} `fingerprint_mismatch`, `auth_failed`, `unreachable`, `timeout` ou `protocol`
   */
  static open(target: RemoteTarget): Promise<RemoteSession> {
    const client = new ssh2.Client()
    let presented: string | null = null
    let mismatch = false
    return new Promise((resolve, reject) => {
      const fail = (e: RemoteError) => {
        client.end()
        reject(e)
      }
      let ready = false
      client.once('ready', () => {
        ready = true
        resolve(new RemoteSession(client))
      })
      // `on`, pas `once` : une erreur après la connexion (hôte éteint en cours
      // de route) sans écouteur ferait tomber le daemon. Elle se voit alors
      // comme un canal fermé, et la commande en cours le dit.
      client.on('error', (e: Error & { level?: string; code?: string }) => {
        if (ready) return
        if (mismatch) {
          return fail(
            new RemoteError(
              'fingerprint_mismatch',
              `host key mismatch for ${target.host}: it presented ${presented}, ${target.fingerprint} was pinned. ` +
                'Nothing was sent. If the VM was reinstalled, read its fingerprint again on its console.',
              presented,
            ),
          )
        }
        if (e.level === 'client-authentication') {
          return fail(new RemoteError('auth_failed', `authentication refused by ${target.host} for ${target.username}: is the public key installed on the VM?`))
        }
        if (e.level === 'client-timeout') {
          return fail(new RemoteError('timeout', `no SSH handshake with ${target.host}:${target.port} in time`))
        }
        if (e.level === 'client-socket' || e.code === 'ECONNREFUSED' || e.code === 'EHOSTUNREACH' || e.code === 'ENOTFOUND') {
          return fail(new RemoteError('unreachable', `cannot reach ${target.host}:${target.port} (${e.code ?? e.message})`))
        }
        fail(new RemoteError('protocol', `SSH error with ${target.host}: ${e.message}`))
      })
      client.connect({
        host: target.host,
        port: target.port,
        username: target.username,
        privateKey: target.privateKey,
        readyTimeout: target.connectTimeoutMs ?? 15_000,
        // Ni agent ni mot de passe ni clavier : la seule clé est celle du coffre.
        agent: undefined,
        tryKeyboard: false,
        hostVerifier: (key: Buffer) => {
          presented = fingerprintOf(key)
          mismatch = presented !== target.fingerprint
          return !mismatch
        },
      })
    })
  }

  /**
   * Lance une commande et attend sa fin, son délai ou son annulation.
   * La commande est une chaîne : c'est le shell de l'hôte qui la lit.
   */
  run(command: string, options: RemoteRunOptions): Promise<RemoteRunResult> {
    const started = Date.now()
    const out = new Bounded()
    const err = new Bounded()
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        return resolve({ code: null, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, timedOut: false, cancelled: true, durationMs: 0 })
      }
      this.client.exec(command, (e: Error | undefined, channel: ClientChannel) => {
        if (e) return reject(new RemoteError('protocol', `could not start the command: ${e.message}`))
        let code: number | null = null
        let timedOut = false
        let cancelled = false
        const stop = (why: 'timeout' | 'cancel') => {
          if (why === 'timeout') timedOut = true
          else cancelled = true
          // Win32-OpenSSH ignore les signaux SSH ; fermer le canal est ce qui
          // reste. Ce que l'hôte fait de ses processus : sous-étape 5.4.
          channel.close()
        }
        const timer = setTimeout(() => stop('timeout'), options.timeoutMs)
        const onAbort = () => stop('cancel')
        options.signal?.addEventListener('abort', onAbort, { once: true })
        channel.on('data', (chunk: Buffer) => {
          out.write(chunk)
          options.onOutput?.('stdout', chunk)
        })
        channel.stderr.on('data', (chunk: Buffer) => {
          err.write(chunk)
          options.onOutput?.('stderr', chunk)
        })
        channel.on('exit', (exitCode: number | null) => {
          code = typeof exitCode === 'number' ? exitCode : null
        })
        channel.on('close', () => {
          clearTimeout(timer)
          options.signal?.removeEventListener('abort', onAbort)
          resolve({
            code: timedOut || cancelled ? null : code,
            stdout: out.text(),
            stderr: err.text(),
            stdoutBytes: out.bytes,
            stderrBytes: err.bytes,
            timedOut,
            cancelled,
            durationMs: Date.now() - started,
          })
        })
      })
    })
  }

  /** Canal SFTP de la session, ouvert à la première copie. */
  private sftp(): Promise<SFTPWrapper> {
    this.sftpChannel ??= new Promise((resolve, reject) => {
      this.client.sftp((e: Error | undefined, sftp: SFTPWrapper) =>
        e ? reject(new RemoteError('protocol', `SFTP unavailable: ${e.message}`)) : resolve(sftp),
      )
    })
    return this.sftpChannel
  }

  /** Crée un dossier distant et ses parents ; sans effet s'il existe. */
  async mkdirp(remoteDir: string): Promise<void> {
    const sftp = await this.sftp()
    const parts = remoteDir.split('/').filter(Boolean)
    let path = remoteDir.startsWith('/') ? '' : '.'
    for (const part of parts) {
      path = `${path}/${part}`
      const exists = await new Promise<boolean>((done) => sftp.stat(path, (e) => done(!e)))
      if (exists) continue
      await new Promise<void>((done, fail) =>
        sftp.mkdir(path, (e) => (e ? fail(new RemoteError('protocol', `cannot create ${path}: ${e.message}`)) : done())),
      )
    }
  }

  /** Copie un fichier local vers un chemin distant. */
  async upload(localPath: string, remotePath: string): Promise<void> {
    const sftp = await this.sftp()
    await new Promise<void>((done, fail) =>
      sftp.fastPut(localPath, remotePath, (e) =>
        e ? fail(new RemoteError('protocol', `cannot copy to ${remotePath}: ${e.message}`)) : done(),
      ),
    )
  }

  /**
   * Copie un arbre local sous un dossier distant (séparateur `/`).
   *
   * Seuls les fichiers et dossiers ordinaires passent : un lien est écarté
   * et nommé, jamais suivi. `exclude` reçoit le chemin relatif (séparateur
   * `/`) et rend le motif d'un refus, ou `null`.
   *
   * @throws {RemoteError} au-delà de {@link UPLOAD_MAX_FILES} fichiers ou
   *         {@link UPLOAD_MAX_BYTES} octets, **avant** toute copie
   */
  async uploadTree(
    localRoot: string,
    remoteRoot: string,
    exclude: (relativePath: string) => string | null = () => null,
  ): Promise<UploadSummary> {
    const files: { local: string; rel: string; size: number }[] = []
    const dirs: string[] = []
    const skipped: UploadSummary['skipped'] = []
    let bytes = 0
    const walk = async (dir: string): Promise<void> => {
      for (const name of (await readdir(dir)).sort()) {
        const local = join(dir, name)
        const rel = relative(localRoot, local).split(sep).join('/')
        const why = exclude(rel)
        if (why) {
          skipped.push({ path: rel, reason: why })
          continue
        }
        const st = await lstat(local)
        if (st.isSymbolicLink()) skipped.push({ path: rel, reason: 'symbolic link, never followed' })
        else if (st.isDirectory()) {
          dirs.push(rel)
          await walk(local)
        } else if (st.isFile()) {
          files.push({ local, rel, size: st.size })
          bytes += st.size
        } else skipped.push({ path: rel, reason: 'not a regular file' })
        if (files.length > UPLOAD_MAX_FILES || bytes > UPLOAD_MAX_BYTES) {
          throw new RemoteError(
            'protocol',
            `too much to copy to the VM: more than ${UPLOAD_MAX_FILES} files or ${UPLOAD_MAX_BYTES} bytes. Nothing was copied.`,
          )
        }
      }
    }
    await walk(localRoot)
    await this.mkdirp(remoteRoot)
    for (const d of dirs) await this.mkdirp(posix.join(remoteRoot, d))
    for (const f of files) await this.upload(f.local, posix.join(remoteRoot, f.rel))
    return { files: files.length, bytes, skipped }
  }

  /**
   * Le dossier personnel du compte, tel que le SFTP le rend pour `.` — sous
   * Windows, `/C:/Users/<compte>`. C'est sous lui que vivent les dossiers de
   * tâche (`task-dir.ts`).
   *
   * @throws {RemoteError} `protocol` si l'hôte ne rend pas un chemin absolu
   */
  async homeDir(): Promise<string> {
    const sftp = await this.sftp()
    const home = await new Promise<string>((done, fail) =>
      sftp.realpath('.', (e, path) => (e ? fail(new RemoteError('protocol', `cannot read the remote home: ${e.message}`)) : done(path))),
    )
    if (!home.startsWith('/')) throw new RemoteError('protocol', `the remote home is not an absolute path: ${home}`)
    return home
  }

  /** `lstat` distant ; `null` si le chemin n'existe pas. */
  private async lstatOrNull(path: string): Promise<Stats | null> {
    const sftp = await this.sftp()
    return new Promise((done) => sftp.lstat(path, (e, st) => done(e ? null : st)))
  }

  /**
   * Efface un dossier distant et tout ce qu'il contient, **sans jamais
   * suivre un lien**, et seulement sous `allowedRoot`.
   *
   * Trois garde-fous, vérifiés avant le premier effacement :
   *
   *  1. `remoteDir` est **strictement** sous `allowedRoot` : la racine permise
   *     elle-même, ou un chemin à côté, est refusé sans rien envoyer ;
   *  2. `allowedRoot` et chaque dossier entre lui et `remoteDir` sont de vrais
   *     dossiers, pas des liens : un lien posé là désignerait un autre endroit
   *     du disque, que l'effacement atteindrait par lui ;
   *  3. chaque entrée est lue par `lstat` : un lien est retiré **lui-même** et
   *     nommé dans le bilan, jamais parcouru.
   *
   * Ce que le SFTP de Win32-OpenSSH dit d'une **jonction** NTFS (lien ou
   * dossier ?) reste à constater sur un vrai Windows (sous-étape 5.5) : tant
   * que ce n'est pas fait, le garde-fou n° 3 n'est prouvé que contre des liens
   * symboliques POSIX.
   *
   * @returns le bilan ; `removed: 0` si le dossier n'existait pas
   * @throws {RemoteError} `protocol` sur un garde-fou, au-delà de
   *         {@link REMOVE_MAX_ENTRIES} entrées, ou si l'hôte refuse un effacement
   */
  async removeTree(remoteDir: string, allowedRoot: string): Promise<RemoveSummary> {
    if (!isStrictlyUnder(remoteDir, allowedRoot)) {
      throw new RemoteError('protocol', `refusing to remove ${remoteDir}: not strictly under ${allowedRoot}. Nothing was removed.`)
    }
    const root = posix.normalize(allowedRoot).replace(/\/+$/, '')
    const target = posix.normalize(remoteDir).replace(/\/+$/, '')
    // Garde-fou n° 2 : la racine et les dossiers intermédiaires. Un maillon
    // absent arrête le contrôle — rien en dessous n'existe à effacer.
    const chain = [root]
    for (const part of target.slice(root.length + 1).split('/').slice(0, -1)) chain.push(posix.join(chain.at(-1)!, part))
    for (const dir of chain) {
      const st = await this.lstatOrNull(dir)
      if (!st) return { removed: 0, links: [] }
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new RemoteError('protocol', `refusing to remove under ${dir}: it is not a plain directory. Nothing was removed.`)
      }
    }

    const sftp = await this.sftp()
    const summary: RemoveSummary = { removed: 0, links: [] }
    let seen = 0
    const call = (op: 'unlink' | 'rmdir', path: string) =>
      new Promise<void>((done, fail) =>
        sftp[op](path, (e) => (e ? fail(new RemoteError('protocol', `cannot remove ${path}: ${e.message}`)) : done())),
      )
    const removeEntry = async (path: string, st: Stats): Promise<void> => {
      if (++seen > REMOVE_MAX_ENTRIES) {
        throw new RemoteError('protocol', `more than ${REMOVE_MAX_ENTRIES} entries under ${target}: removal stopped`)
      }
      if (st.isSymbolicLink()) {
        // Retiré, jamais parcouru. Un lien vers un dossier peut demander
        // `rmdir` selon l'hôte : on essaie l'un, puis l'autre.
        await call('unlink', path).catch(() => call('rmdir', path))
        summary.links.push(path.slice(target.length + 1) || '.')
        summary.removed++
        return
      }
      if (st.isDirectory()) {
        const entries = await new Promise<{ filename: string }[]>((done, fail) =>
          sftp.readdir(path, (e, list) => (e ? fail(new RemoteError('protocol', `cannot list ${path}: ${e.message}`)) : done(list))),
        )
        for (const { filename } of entries) {
          if (filename === '.' || filename === '..' || filename.includes('/')) continue
          const child = posix.join(path, filename)
          // `lstat` à nouveau, plutôt que les attributs de `readdir` : ce
          // qu'un serveur y met n'est pas garanti par le protocole.
          const childSt = await this.lstatOrNull(child)
          if (childSt) await removeEntry(child, childSt)
        }
        await call('rmdir', path)
      } else {
        await call('unlink', path)
      }
      summary.removed++
    }
    const st = await this.lstatOrNull(target)
    if (st) await removeEntry(target, st)
    return summary
  }

  /**
   * Remplace un dossier distant par la copie d'un arbre local : l'ancien est
   * effacé ({@link removeTree}, sous `allowedRoot`), puis l'arbre recopié
   * ({@link uploadTree}). Un fichier retiré de l'arbre local disparaît ainsi
   * du distant, et rien de ce qu'une commande précédente a laissé ne reste.
   */
  async replaceTree(
    localRoot: string,
    remoteDir: string,
    allowedRoot: string,
    exclude?: (relativePath: string) => string | null,
  ): Promise<UploadSummary & { removedBefore: RemoveSummary }> {
    const removedBefore = await this.removeTree(remoteDir, allowedRoot)
    const uploaded = await this.uploadTree(localRoot, remoteDir, exclude)
    return { ...uploaded, removedBefore }
  }

  /** Ferme la session. Idempotente, ne lève pas. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.client.end()
  }
}
