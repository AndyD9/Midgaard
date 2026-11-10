/**
 * @file Un hôte SSH factice, dans le processus des tests (Slice 9, étape 5).
 *
 * Il tient lieu de VM Windows là où il n'y en a pas — sur le Mac de l'auteur,
 * sous Linux en CI — pour éprouver ce qui ne dépend pas de Windows : la
 * comparaison d'empreinte **avant** toute authentification, la clé acceptée
 * ou refusée, le délai et l'annulation d'une commande, la copie par SFTP.
 * Ce que Windows fait d'une session coupée se constate sur un vrai Windows
 * (sous-étape 5.4), jamais ici.
 *
 * Les commandes sont un petit langage de test, pas un shell :
 *
 *  - `echo <texte>` écrit le texte sur la sortie standard ;
 *  - `stderr <texte>` l'écrit sur la sortie d'erreur ;
 *  - `exit <n>` sort avec le code `n` ;
 *  - `sleep <ms>` attend, puis sort avec 0 — sauf si le canal est fermé avant,
 *    ce que `closedEarly` compte ;
 *  - `flood <n>` écrit `n` octets ;
 *  - `powershell.exe … -EncodedCommand <b64>` : le script décodé est noté
 *    (`scripts`), et l'hôte répond comme un Windows 11 à `$PSVersionTable` —
 *    deux lignes, version de PowerShell puis de Windows ;
 *  - toute autre commande sort avec 127.
 *
 * Le SFTP est adossé à un vrai dossier (`root`) : ouvrir, écrire, fermer,
 * `stat`, `mkdir`. Un chemin qui remonterait au-dessus est refusé. Une lettre
 * de lecteur en tête (`/C:/…`, la forme du SFTP de Windows) devient un simple
 * dossier (`C/…`) : Windows interdit le deux-points dans un nom de fichier, et
 * l'hôte factice tourne aussi sous Windows en CI — vu échouer ainsi.
 */
import { closeSync, mkdirSync, openSync, statSync, writeSync } from 'node:fs'
import { join, normalize } from 'node:path'
import type { AddressInfo } from 'node:net'
import ssh2 from 'ssh2'
import { scriptOfPowershellCommand } from '@midgaard/remote'

const { STATUS_CODE } = ssh2.utils.sftp

/** Un hôte factice démarré. */
export interface FakeSshServer {
  port: number
  /** Ligne publique de la clé d'hôte, et son empreinte comme la lirait `ssh-keygen -lf`. */
  hostPublicKey: string
  /** Tentatives d'authentification reçues, toutes méthodes confondues. */
  authAttempts: number
  /** Commandes reçues, dans l'ordre. */
  commands: string[]
  /** Scripts PowerShell reçus, décodés. */
  scripts: string[]
  /** Commandes dont le canal a été fermé par le client avant leur fin. */
  closedEarly: number
  /** Dossier où le SFTP écrit. */
  root: string
  close(): Promise<void>
}

/**
 * Démarre un hôte factice sur la boucle locale.
 *
 * @param authorizedKey ligne publique de la seule clé acceptée
 * @param root          dossier réel derrière le SFTP
 */
export async function startFakeSshServer(authorizedKey: string, root: string): Promise<FakeSshServer> {
  const host = ssh2.utils.generateKeyPairSync('ed25519')
  const allowed = ssh2.utils.parseKey(authorizedKey)
  if (allowed instanceof Error) throw allowed
  const key = Array.isArray(allowed) ? allowed[0]! : allowed

  const state = {
    authAttempts: 0,
    commands: [] as string[],
    scripts: [] as string[],
    closedEarly: 0,
  }

  /** Chemin réel d'un chemin SFTP, jamais au-dessus de `root`. */
  const real = (path: string): string | null => {
    const drive = path.replace(/^\/([A-Za-z]):(?=\/|$)/, '/$1')
    const rel = normalize(drive.replace(/^\/+/, '')).replace(/^(\.\.(\/|\\|$))+/, '')
    if (rel.startsWith('..')) return null
    return join(root, rel)
  }

  const server = new ssh2.Server({ hostKeys: [host.private] }, (client) => {
    client.on('authentication', (ctx) => {
      state.authAttempts++
      if (ctx.method !== 'publickey' || ctx.key.algo !== key.type || Buffer.compare(ctx.key.data, key.getPublicSSH()) !== 0) {
        return ctx.reject(['publickey'])
      }
      if (!ctx.signature) return ctx.accept()
      return key.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true ? ctx.accept() : ctx.reject(['publickey'])
    })
    client.on('error', () => {})
    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession()
        session.on('exec', (accept, _reject, info) => {
          const channel = accept()
          state.commands.push(info.command)
          const [verb, ...rest] = info.command.split(' ')
          const arg = rest.join(' ')
          let done = false
          const finish = (code: number) => {
            if (done) return
            done = true
            channel.exit(code)
            channel.end()
          }
          // Une fermeture par le client se voit côté hôte comme `finish` sur le
          // canal, ou `close` sur la session — pas `close` sur le canal
          // (constaté avec ssh2 1.17). On compte la première, une fois.
          const closedByClient = () => {
            if (!done) state.closedEarly++
            done = true
          }
          channel.on('finish', closedByClient)
          channel.on('close', closedByClient)
          session.on('close', closedByClient)
          if (verb === 'echo') {
            channel.write(`${arg}\n`)
            finish(0)
          } else if (verb === 'stderr') {
            channel.stderr.write(`${arg}\n`)
            finish(0)
          } else if (verb === 'exit') finish(Number(arg))
          else if (verb === 'sleep') setTimeout(() => finish(0), Number(arg))
          else if (verb === 'flood') {
            channel.write(Buffer.alloc(Number(arg), 'x'))
            finish(0)
          } else if (verb === 'powershell.exe') {
            const script = scriptOfPowershellCommand(info.command)
            if (script === null) return finish(64)
            state.scripts.push(script)
            channel.write('5.1.26100.4202\r\nMicrosoft Windows NT 10.0.26100.0\r\n')
            finish(0)
          } else finish(127)
        })
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp()
          const handles = new Map<number, number>()
          let next = 0
          sftp.on('OPEN', (reqid, filename) => {
            const path = real(filename)
            if (!path) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED)
            try {
              const fd = openSync(path, 'w')
              const id = next++
              handles.set(id, fd)
              const handle = Buffer.alloc(4)
              handle.writeUInt32BE(id, 0)
              sftp.handle(reqid, handle)
            } catch {
              sftp.status(reqid, STATUS_CODE.FAILURE)
            }
          })
          sftp.on('WRITE', (reqid, handle, offset, data) => {
            const fd = handles.get(handle.readUInt32BE(0))
            if (fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE)
            writeSync(fd, data, 0, data.length, offset)
            sftp.status(reqid, STATUS_CODE.OK)
          })
          sftp.on('CLOSE', (reqid, handle) => {
            const id = handle.readUInt32BE(0)
            const fd = handles.get(id)
            if (fd !== undefined) closeSync(fd)
            handles.delete(id)
            sftp.status(reqid, STATUS_CODE.OK)
          })
          const stat = (reqid: number, filename: string) => {
            const path = real(filename)
            try {
              if (!path) throw new Error('outside')
              const st = statSync(path)
              sftp.attrs(reqid, { mode: st.mode, uid: 0, gid: 0, size: st.size, atime: 0, mtime: 0 })
            } catch {
              sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
            }
          }
          sftp.on('STAT', stat)
          sftp.on('LSTAT', stat)
          sftp.on('MKDIR', (reqid, filename) => {
            const path = real(filename)
            if (!path) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED)
            try {
              mkdirSync(path)
              sftp.status(reqid, STATUS_CODE.OK)
            } catch {
              sftp.status(reqid, STATUS_CODE.FAILURE)
            }
          })
        })
      })
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return {
    port: (server.address() as AddressInfo).port,
    hostPublicKey: host.public,
    get authAttempts() {
      return state.authAttempts
    },
    get commands() {
      return state.commands
    },
    get scripts() {
      return state.scripts
    },
    get closedEarly() {
      return state.closedEarly
    },
    root,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
