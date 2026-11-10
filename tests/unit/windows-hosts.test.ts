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
 *
 * Et l'attache à un profil (étape 5.3a) : un Developer seul, une VM déclarée,
 * l'agent créé qui en hérite, la CLI qui attache et détache, le retrait d'une
 * VM qui la détache des profils.
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
  type Agent,
  type AgentResponse,
  type CreatedAgent,
  type RuntimeInfo,
  type WindowsHostResponse,
  type WindowsHostsResponse,
} from '@midgaard/contracts'
import { WINDOWS_TEST_SCRIPT, resolveCreatedAgent, startDaemon, windowsKeyRef, type Daemon } from '@midgaard/daemon'
import type { HarnessStore } from '@midgaard/persistence'
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

  it('un agent créé hérite de la VM de son profil de base', () => {
    const base = { id: 'developer', provider_id: 'venice', model: 'm', vision: null, system_prompt: 'rules', windows_host: 'vm1' } as Agent
    const created = {
      id: 'c1', name: 'Checker', base_agent_id: 'developer', provider_id: 'venice', model: 'm', role: 'check', mcp_servers: [],
      limits: {}, task_id: 't', created_at: '',
    } as unknown as CreatedAgent
    const store = { getAgent: (id: string) => (id === 'developer' ? base : null) } as unknown as HarnessStore
    assert.equal(resolveCreatedAgent(store, created)?.windows_host, 'vm1')
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

  /** Lance la vraie CLI contre ce daemon, et rend son code et tout ce qu'elle a écrit. */
  const runCli = (args: string[]) =>
    new Promise<{ code: number | null; text: string }>((resolve) => {
      const child = spawn(process.execPath, [...nodeArgsFor('@midgaard/cli/main'), ...args], {
        env: childEnv(home),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let text = ''
      child.stdout!.on('data', (c) => (text += c))
      child.stderr!.on('data', (c) => (text += c))
      child.on('close', (code) => resolve({ code, text }))
    })

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

  it('s\'attache à un Developer seul, et seulement si la VM est déclarée', async () => {
    const researcher = await api('/api/agents/researcher/windows', 'PUT', { host: 'vm1' })
    assert.equal(researcher.status, 409)
    assert.equal(researcher.body.error, 'agent_cannot_use_windows')
    const unknown = await api<{ available: string[] }>('/api/agents/developer/windows', 'PUT', { host: 'nope' })
    assert.equal(unknown.status, 404)
    assert.deepEqual(unknown.body.available, ['vm1'], 'le refus dit les VM déclarées')
    assert.equal((await api('/api/agents/developer/windows', 'PUT', { host: 'vm1', extra: 1 })).status, 200, 'champ inconnu ignoré')
    assert.equal((await api('/api/agents/developer/windows', 'PUT', {})).status, 400, 'host est exigé, null pour détacher')
    assert.equal((await api('/api/agents/developer/windows', 'GET')).status, 405)
    assert.equal((await api('/api/agents/nobody/windows', 'PUT', { host: 'vm1' })).status, 404)

    const developer = await api<AgentResponse>('/api/agents/developer')
    assert.equal(developer.body.agent.windows_host, 'vm1')
    assert.equal((await api<AgentResponse>('/api/agents/researcher')).body.agent.windows_host, null)
    assert.ok(logged.some((l) => l.includes('profil « developer » : VM Windows vm1, avant (aucune)')), 'l\'attache est journalisée')

    // Détacher est toujours permis, même d'un profil qui ne peut pas en avoir.
    const detached = await api<AgentResponse>('/api/agents/developer/windows', 'PUT', { host: null })
    assert.equal(detached.body.agent.windows_host, null)
    assert.equal((await api('/api/agents/researcher/windows', 'PUT', { host: null })).status, 200)
  })

  it('la CLI attache, refuse un Researcher, montre l\'attache et détache', async () => {
    const attached = await runCli(['windows', 'attach', 'vm1', 'developer'])
    assert.equal(attached.code, 0, attached.text)
    assert.match(attached.text, /attachée à developer/)
    assert.match(attached.text, /Aucun outil ne s'en sert encore/, 'rien d\'annoncé qui n\'existe pas encore')
    assert.equal((await api<AgentResponse>('/api/agents/developer')).body.agent.windows_host, 'vm1')

    const refused = await runCli(['windows', 'attach', 'vm1', 'researcher'])
    assert.equal(refused.code, 1)
    assert.match(refused.text, /seul un profil developer/)

    const listed = await runCli(['windows', 'list'])
    assert.match(listed.text, /attachée à : developer/, listed.text)

    const off = await runCli(['windows', 'detach', 'developer'])
    assert.equal(off.code, 0, off.text)
    assert.equal((await api<AgentResponse>('/api/agents/developer')).body.agent.windows_host, null)
    assert.match((await runCli(['windows', 'detach', 'developer'])).text, /n'a pas de VM/)
  })

  it('le retrait efface la clé du coffre et détache la VM des profils', async () => {
    const vault = await openVault(config, env)
    const ref = await windowsKeyRef(home, 'vm1')
    assert.ok(await vault.get(ref))
    assert.equal((await api('/api/agents/developer/windows', 'PUT', { host: 'vm1' })).status, 200)
    const removed = await api<{ detached: string[] }>('/api/windows/vm1', 'DELETE')
    assert.equal(removed.status, 200)
    assert.equal(await vault.get(ref), null)
    // Détachée d'abord : une VM redéclarée sous le même nom ne se retrouve pas
    // attachée sans que l'humain l'ait redemandé.
    assert.deepEqual(removed.body.detached, ['developer'])
    assert.equal((await api<AgentResponse>('/api/agents/developer')).body.agent.windows_host, null)
    assert.equal((await api('/api/windows/vm1')).status, 404)
    assert.equal((await api('/api/windows/vm1/test', 'POST')).status, 404)
  })

  it('la CLI refuse une première déclaration sans empreinte, et dit comment la lire', async () => {
    const out = await runCli(['windows', 'add', 'vm2', '--host', '127.0.0.1', '--user', 'analyste'])
    assert.equal(out.code, 1)
    assert.ok(out.text.includes(WINDOWS_FINGERPRINT_COMMAND), out.text)
    assert.equal(existsSync(join(home, 'harness.db')), true)
    assert.deepEqual((await api<WindowsHostsResponse>('/api/windows')).body.hosts, [], 'rien n\'a été déclaré')
  })
})
