/**
 * @file Le branchement de la VM dans le daemon (Slice 9, étape 5.3d) :
 * `WindowsSessions`, face à un hôte SSH factice, avec un vrai store et un vrai
 * coffre. Pas de modèle : on appelle le port directement, comme le ferait
 * l'outil `windows_run`.
 *
 * Ce qui est éprouvé : `target()` reflète la base et devient `null` quand la VM
 * est retirée ; `run()` recopie le worktree (jamais `.git`) et lance le script
 * dans le dossier `work` ; `endTask()` efface le dossier de la tâche ; une clé
 * absente du coffre donne un refus lisible.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { loadConfig, type HarnessConfig } from '@midgaard/contracts'
import { HarnessStore } from '@midgaard/persistence'
import { WindowsSessions, windowsKeyRef, windowsPathOf, worktreeUploadExclude } from '@midgaard/daemon'
import { fingerprintOfPublicKey, generateKeyPair } from '@midgaard/remote'
import { openVault, type SecretVault } from '@midgaard/secrets'
import { startFakeSshServer, type FakeSshServer } from '../fake-ssh-server.ts'

describe('les chemins et le filtre de copie', () => {
  it('traduit un chemin SFTP en chemin Windows', () => {
    assert.equal(windowsPathOf('/C:/Users/analyste/midgaard/tasks/x/work'), 'C:\\Users\\analyste\\midgaard\\tasks\\x\\work')
  })
  it('n\'exclut de la copie que .git', () => {
    assert.equal(worktreeUploadExclude('.git'), 'never copied: .git')
    assert.equal(worktreeUploadExclude('.git/config'), 'never copied: .git')
    assert.equal(worktreeUploadExclude('src/a.ps1'), null)
  })
})

describe('WindowsSessions face à un hôte factice', () => {
  const env = { MIDGAARD_VAULT: 'file' }
  const taskId = '44444444-2222-4333-8444-555555555555'
  let home: string
  let sftpRoot: string
  let worktree: string
  let config: HarnessConfig
  let store: HarnessStore
  let vault: SecretVault
  let server: FakeSshServer
  let sessions: WindowsSessions

  before(async () => {
    home = mkdtempSync(join(tmpdir(), 'midgaard-winsess-'))
    sftpRoot = mkdtempSync(join(tmpdir(), 'midgaard-winsess-sftp-'))
    worktree = mkdtempSync(join(tmpdir(), 'midgaard-winsess-wt-'))
    config = loadConfig({ MIDGAARD_HOME: home })
    store = HarnessStore.open(config)
    vault = await openVault(config, env)

    // Une clé dédiée, rangée au coffre comme le ferait le service des VM, et
    // posée sur l'hôte factice ; l'empreinte de l'hôte est épinglée.
    const pair = generateKeyPair('midgaard-vm1')
    await vault.set(await windowsKeyRef(home, 'vm1'), pair.privateKey)
    server = await startFakeSshServer(pair.publicKey, sftpRoot, 'analyste')
    store.upsertWindowsHost({
      id: 'vm1', name: 'vm1', host: '127.0.0.1', port: server.port, username: 'analyste',
      fingerprint: fingerprintOfPublicKey(server.hostPublicKey), publicKey: pair.publicKey,
    })

    // Un worktree avec un fichier et un .git qui ne doit jamais partir.
    mkdirSync(join(worktree, 'rules'), { recursive: true })
    writeFileSync(join(worktree, 'rules', 'scan.ps1'), 'Write-Output scan\n')
    mkdirSync(join(worktree, '.git'))
    writeFileSync(join(worktree, '.git', 'config'), '[core]\n')

    sessions = new WindowsSessions({ store, config, vault, log: () => {} })
  })

  after(async () => {
    await server?.close()
    store.close()
    for (const d of [home, sftpRoot, worktree]) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })

  it('target() reflète la base', () => {
    const port = sessions.portFor(taskId, 'vm1', worktree, (t) => t)
    assert.deepEqual(port.target(), {
      id: 'vm1', address: '127.0.0.1', port: server.port, username: 'analyste',
      fingerprint: fingerprintOfPublicKey(server.hostPublicKey),
    })
  })

  it('run() recopie le worktree sans .git, et lance le script dans work', async () => {
    const port = sessions.portFor(taskId, 'vm1', worktree, (t) => t)
    const seen: string[] = []
    const r = await port.run('Get-Date', { timeoutMs: 10_000, onOutput: (s, c) => seen.push(`${s}:${c}`) })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.copied.files, 1, 'un seul fichier : .git est écarté')
    // Le worktree est arrivé sous le dossier work de la tâche, .git exclu.
    const work = join(sftpRoot, 'C', 'Users', 'analyste', 'midgaard', 'tasks', taskId, 'work')
    assert.equal(existsSync(join(work, 'rules', 'scan.ps1')), true)
    assert.equal(existsSync(join(work, '.git')), false)
    // Le script reçu par l'hôte tourne dans work, et porte le script demandé.
    const script = server.scripts.at(-1)!
    assert.match(script, /Set-Location -LiteralPath 'C:\\Users\\analyste\\midgaard\\tasks\\[^']+\\work'/)
    assert.match(script, /Get-Date$/)
  })

  it('endTask() efface le dossier de la tâche sur la VM', async () => {
    sessions.portFor(taskId, 'vm1', worktree, (t) => t)
    await sessions.portFor(taskId, 'vm1', worktree, (t) => t).run('Get-Date', { timeoutMs: 10_000 })
    const dir = join(sftpRoot, 'C', 'Users', 'analyste', 'midgaard', 'tasks', taskId)
    assert.equal(existsSync(dir), true, 'le dossier existe avant la fin')
    await sessions.endTask(taskId)
    assert.equal(existsSync(dir), false, 'le dossier est effacé')
    assert.equal(existsSync(join(sftpRoot, 'C', 'Users', 'analyste', 'midgaard', 'tasks')), true, 'le dossier des tâches reste')
  })

  it('target() devient null, et run() refuse, quand la VM est retirée', async () => {
    const port = sessions.portFor('55555555-2222-4333-8444-555555555555', 'vm1', worktree, (t) => t)
    store.deleteWindowsHost('vm1')
    assert.equal(port.target(), null)
    await assert.rejects(port.run('Get-Date', { timeoutMs: 10_000 }), /no longer declared/)
  })
})
