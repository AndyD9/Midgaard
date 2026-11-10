/**
 * @file La déclaration d'une VM Windows (Slice 9, étape 5.2), dans un vrai
 * daemon, face à un hôte SSH factice.
 *
 * Ce qui est éprouvé : les commandes données à l'humain (SID plutôt que noms
 * de groupes, script PowerShell transmis intact) ; une déclaration **sans
 * empreinte refusée** ; la clé générée par le daemon, rangée au coffre,
 * **absente de toute réponse, de la base et du journal** — lus octet pour
 * octet ; le test qui fait répondre PowerShell ; une empreinte fausse
 * refusée sans tentative d'authentification ; une clé remplacée qui cesse de
 * servir ; le dernier test effacé quand ce qu'on joint change ; le retrait,
 * clé effacée du coffre ; et la CLI qui refuse sans empreinte en disant
 * comment la lire.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  WINDOWS_FINGERPRINT_COMMAND,
  daemonJson,
  loadConfig,
  readRuntime,
  windowsInstallCommands,
  type HarnessConfig,
  type RuntimeInfo,
  type WindowsHostResponse,
  type WindowsHostsResponse,
} from '@midgaard/contracts'
import { WINDOWS_TEST_SCRIPT, startDaemon, windowsKeyRef, type Daemon } from '@midgaard/daemon'
import { parseWindowsAddArgs } from '@midgaard/cli'
import { fingerprintOfPublicKey, generateKeyPair, powershellCommand, scriptOfPowershellCommand } from '@midgaard/remote'
import { openVault } from '@midgaard/secrets'
import { startFakeSshServer, type FakeSshServer } from '../fake-ssh-server.ts'
import { childEnv, nodeArgsFor } from '../helpers.ts'

describe('ce qu\'on dit de lancer sur la VM', () => {
  it('pose la clé pour un administrateur, groupes désignés par leur SID', () => {
    const [add, acl] = windowsInstallCommands('ssh-ed25519 AAAAC3Nza midgaard-vm1')
    assert.equal(add, `Add-Content -Path "$env:ProgramData\\ssh\\administrators_authorized_keys" -Value 'ssh-ed25519 AAAAC3Nza midgaard-vm1'`)
    // Le nom « Administrators » change avec la langue de Windows ; le SID non.
    assert.match(acl!, /\/inheritance:r \/grant '\*S-1-5-32-544:F' \/grant '\*S-1-5-18:F'$/)
    assert.throws(() => windowsInstallCommands("ssh-ed25519 AAAA x'; Remove-Item C:\\"), /apostrophe/)
  })

  it('fait voyager un script PowerShell intact, accents et guillemets compris', () => {
    const script = '$x = "été" ; Write-Output \'a & b | c\'\nGet-Date'
    const line = powershellCommand(script)
    assert.match(line, /^powershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand [A-Za-z0-9+/=]+$/)
    assert.equal(scriptOfPowershellCommand(line), script)
  })

  it('lit les arguments de windows add', () => {
    const a = parseWindowsAddArgs(['vm1', '--host', '10.0.0.5', '--user', 'analyste', '--fingerprint', '256 SHA256:x (ED25519)', '--port', '2222', '--new-key'])
    assert.deepEqual(a, { id: 'vm1', host: '10.0.0.5', user: 'analyste', fingerprint: '256 SHA256:x (ED25519)', port: 2222, newKey: true })
    assert.ok('error' in parseWindowsAddArgs(['vm1', '--port', '70000']))
    assert.ok('error' in parseWindowsAddArgs(['--host', 'x']))
  })
})

describe('une VM déclarée dans un vrai daemon', () => {
  let home: string
  let sftpRoot: string
  let config: HarnessConfig
  let daemon: Daemon
  let rt: RuntimeInfo
  let server: FakeSshServer | null = null
  const env = { MIDGAARD_VAULT: 'file' }

  const api = <T>(path: string, method = 'GET', body?: unknown) =>
    daemonJson<T & { error?: string; reason?: string }>(rt, path, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    })

  /** Ce que le daemon a journalisé : il tourne dans le processus, son journal passe par ici. */
  const logged: string[] = []

  /** Tout ce que le daemon a écrit : base (fichiers SQLite) et journal. */
  const everythingWritten = (): string =>
    [
      ...readdirSync(home)
        .filter((f) => /\.db(-wal)?$/.test(f))
        .map((f) => readFileSync(join(home, f)).toString('latin1')),
      ...logged,
    ].join('\n')

  before(async () => {
    home = mkdtempSync(join(tmpdir(), 'midgaard-windows-'))
    sftpRoot = mkdtempSync(join(tmpdir(), 'midgaard-windows-sftp-'))
    config = loadConfig({ MIDGAARD_HOME: home, MIDGAARD_PORT: '0' })
    daemon = (await startDaemon(config, {
      log: (...a: unknown[]) => void logged.push(a.map(String).join(' ')),
      env: { ...env, PATH: process.env.PATH ?? '' },
    }))!
    rt = readRuntime(config.runtimeFile)!
  })

  after(async () => {
    await server?.close()
    daemon.close('fin des tests')
    await daemon.stopped
    for (const d of [home, sftpRoot]) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })

  it('refuse une déclaration sans empreinte, ou illisible', async () => {
    const none = await api('/api/windows', 'POST', { id: 'vm1', host: '127.0.0.1', username: 'analyste' })
    assert.equal(none.status, 400)
    assert.equal(none.body.error, 'fingerprint_required')
    const md5 = await api('/api/windows', 'POST', { id: 'vm1', host: '127.0.0.1', username: 'analyste', fingerprint: 'MD5:aa:bb' })
    assert.equal(md5.body.error, 'invalid_fingerprint')
    const url = await api('/api/windows', 'POST', { id: 'vm1', host: 'ssh://127.0.0.1', username: 'analyste', fingerprint: 'x' })
    assert.equal(url.status, 400, 'une URL n\'est pas une adresse')
    assert.deepEqual((await api<WindowsHostsResponse>('/api/windows')).body.hosts, [])
  })

  it('génère la clé au coffre, n\'en montre que la moitié publique, et le test fait répondre PowerShell', async () => {
    // L'empreinte de l'hôte factice n'est connue qu'une fois démarré, et il
    // n'accepte que la clé que le daemon va générer : on déclare d'abord avec
    // une empreinte provisoire, puis on épingle la vraie.
    const provisional = fingerprintOfPublicKey(generateKeyPair('x').publicKey)
    const created = await api<WindowsHostResponse>('/api/windows', 'POST', {
      id: 'vm1', host: '127.0.0.1', username: 'analyste', fingerprint: `256 ${provisional} root@vm (ED25519)`,
    })
    assert.equal(created.status, 200, JSON.stringify(created.body))
    const host = created.body.host
    assert.equal(host.fingerprint, provisional, 'la ligne de ssh-keygen -lf est lue')
    assert.match(host.public_key, /^ssh-ed25519 \S+ midgaard-vm1$/)
    assert.deepEqual(host.install_commands, windowsInstallCommands(host.public_key))
    assert.doesNotMatch(JSON.stringify(created.body), /PRIVATE KEY/)

    const vault = await openVault(config, env)
    const privateKey = await vault.get(await windowsKeyRef(home, 'vm1'))
    assert.match(privateKey ?? '', /^-----BEGIN OPENSSH PRIVATE KEY-----/)

    server = await startFakeSshServer(host.public_key, sftpRoot)
    const pinned = await api<WindowsHostResponse>('/api/windows', 'POST', {
      id: 'vm1', host: '127.0.0.1', port: server.port, username: 'analyste', fingerprint: fingerprintOfPublicKey(server.hostPublicKey),
    })
    assert.equal(pinned.body.host.public_key, host.public_key, 'la clé ne change pas sans --new-key')

    const tested = await api<WindowsHostResponse>('/api/windows/vm1/test', 'POST')
    const t = tested.body.host.last_test!
    assert.equal(t.ok, true, t.detail)
    assert.equal(t.powershell, '5.1.26100.4202')
    assert.equal(t.os, 'Microsoft Windows NT 10.0.26100.0')
    assert.deepEqual(server.scripts, [WINDOWS_TEST_SCRIPT], 'le script arrive intact')

    // Le début du corps base64 est le même pour toute clé OpenSSH (en-tête du
    // format) : on cherche un morceau du milieu, propre à cette clé.
    const material = privateKey!.replace(/-----[^-]+-----|\s/g, '').slice(80, 140)
    assert.equal(material.length, 60)
    const written = everythingWritten()
    assert.ok(written.includes('vm1') && logged.some((l) => /VM Windows « vm1 »/.test(l)), 'le témoin : base et journal sont bien lus')
    // Sans blancs des deux côtés : une clé PEM écrite telle quelle a un retour
    // à la ligne tous les 70 caractères, qui couperait le morceau cherché —
    // c'est ainsi qu'une fuite au journal passait d'abord inaperçue.
    assert.ok(!written.replace(/\s/g, '').includes(material), 'la clé privée n\'est ni en base ni au journal')
  })

  it('refuse un hôte qui présente une autre empreinte, sans s\'y authentifier', async () => {
    const attempts = server!.authAttempts
    const other = fingerprintOfPublicKey(generateKeyPair('autre').publicKey)
    const changed = await api<WindowsHostResponse>('/api/windows', 'POST', {
      id: 'vm1', host: '127.0.0.1', port: server!.port, username: 'analyste', fingerprint: other,
    })
    assert.equal(changed.body.host.last_test, null, 'changer l\'empreinte efface le dernier test')
    const t = (await api<WindowsHostResponse>('/api/windows/vm1/test', 'POST')).body.host.last_test!
    assert.equal(t.ok, false)
    assert.equal(t.presented_fingerprint, fingerprintOfPublicKey(server!.hostPublicKey))
    assert.match(t.detail, /rien n'a été envoyé/)
    assert.equal(server!.authAttempts, attempts, 'aucune tentative d\'authentification')
  })

  it('une nouvelle clé remplace l\'ancienne, qui ne sert plus', async () => {
    const real = fingerprintOfPublicKey(server!.hostPublicKey)
    const before = (await api<WindowsHostResponse>('/api/windows/vm1')).body.host.public_key
    const renewed = await api<WindowsHostResponse>('/api/windows', 'POST', {
      id: 'vm1', host: '127.0.0.1', port: server!.port, username: 'analyste', fingerprint: real, new_key: true,
    })
    assert.notEqual(renewed.body.host.public_key, before)
    const t = (await api<WindowsHostResponse>('/api/windows/vm1/test', 'POST')).body.host.last_test!
    assert.equal(t.ok, false)
    assert.match(t.detail, /refuse la clé de Midgaard/, 'l\'hôte ne connaît que l\'ancienne clé')
  })

  it('le retrait efface la clé du coffre', async () => {
    const vault = await openVault(config, env)
    const ref = await windowsKeyRef(home, 'vm1')
    assert.ok(await vault.get(ref))
    assert.equal((await api('/api/windows/vm1', 'DELETE')).status, 200)
    assert.equal(await vault.get(ref), null)
    assert.equal((await api('/api/windows/vm1')).status, 404)
    assert.equal((await api('/api/windows/vm1/test', 'POST')).status, 404)
  })

  it('la CLI refuse une première déclaration sans empreinte, et dit comment la lire', async () => {
    const out = await new Promise<{ code: number | null; text: string }>((resolve) => {
      const child = spawn(
        process.execPath,
        [...nodeArgsFor('@midgaard/cli/main'), 'windows', 'add', 'vm2', '--host', '127.0.0.1', '--user', 'analyste'],
        { env: childEnv(home), stdio: ['ignore', 'pipe', 'pipe'] },
      )
      let text = ''
      child.stdout!.on('data', (c) => (text += c))
      child.stderr!.on('data', (c) => (text += c))
      child.on('close', (code) => resolve({ code, text }))
    })
    assert.equal(out.code, 1)
    assert.ok(out.text.includes(WINDOWS_FINGERPRINT_COMMAND), out.text)
    assert.equal(existsSync(join(home, 'harness.db')), true)
    assert.deepEqual((await api<WindowsHostsResponse>('/api/windows')).body.hosts, [], 'rien n\'a été déclaré')
  })
})
