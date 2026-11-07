/**
 * @file Les échantillons d'une tâche (Slice 9, étape 4) : copie en lecture
 * seule, vérification, effacement, transmission par un orchestrateur, et la
 * garde d'`exec` qui refuse de les faire tourner.
 *
 * Trois niveaux, du plus étroit au plus large :
 *
 *  - la garde (`sampleExecRefusal`) sur une table de commandes : ce qui lance,
 *    charge ou émule un échantillon est refusé, ce qui le lit passe ;
 *  - le module du daemon (`samples.ts`) sur un vrai disque : copie, droits,
 *    empreintes, refus, effacement borné à `samplesDir`, balayage ;
 *  - un vrai daemon face au faux fournisseur : ce que l'agent lit, la note de
 *    la timeline, l'effacement en fin de tâche, les refus de la route, et la
 *    transmission d'un orchestrateur à sa sous-tâche, par nom seulement.
 *
 * Le chemin du Developer — `exec` refusé dans un vrai worktree, `uv sync`
 * proposé au départ — est dans `tests/developer.ts` (V15, V16).
 */
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, afterEach, describe, it } from 'node:test'
import { daemonJson, loadConfig, readRuntime, sampleNameFor, type HarnessConfig, type RuntimeInfo, type Task } from '@midgaard/contracts'
import {
  RESEARCHER_AGENT_ID,
  adoptStaged,
  reconcileAgents,
  removeTaskSamples,
  sha256File,
  stageForwarded,
  stageSamples,
  startDaemon,
  sweepSamples,
  taskSamplesDir,
  verifySamples,
  type Daemon,
  type StagedSamples,
} from '@midgaard/daemon'
import { HarnessStore } from '@midgaard/persistence'
import { findTool, sampleExecRefusal, type SamplesContext, type ToolContext } from '@midgaard/tools'
import { startFakeProvider, type FakeProvider } from '../fake-provider.ts'

/** Les droits POSIX ne disent rien sous Windows : le cas doit le dire. */
const POSIX_ONLY = process.platform === 'win32' ? 'Windows n\'a pas de bits de droits POSIX' : false

describe('sampleNameFor', () => {
  it('garde un nom sûr, sans séparateur ni point en tête', () => {
    assert.equal(sampleNameFor('invoice.exe', []), 'invoice.exe')
    assert.equal(sampleNameFor('../a b;c.dll', []), '_a_b_c.dll')
    assert.equal(sampleNameFor('.hidden', []), 'hidden')
    assert.equal(sampleNameFor('évil.exe', []), '_vil.exe')
  })

  it('suffixe un doublon, sans tenir compte de la casse', () => {
    assert.equal(sampleNameFor('a.exe', ['A.EXE']), 'a-2.exe')
    assert.equal(sampleNameFor('a.exe', ['a.exe', 'a-2.exe']), 'a-3.exe')
  })
})

describe('sampleExecRefusal', () => {
  let dir: string
  let work: string
  let samples: SamplesContext
  const evil = 'MZ\u0090\u0000 fake PE for the guard\n'

  before(async () => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'midgaard-guard-samples-')))
    work = realpathSync.native(mkdtempSync(join(tmpdir(), 'midgaard-guard-work-')))
    writeFileSync(join(dir, 'evil.exe'), evil)
    // Une copie identique dans le worktree, et un fichier ordinaire de même taille.
    writeFileSync(join(work, 'copy.bin'), evil)
    writeFileSync(join(work, 'other.bin'), 'x'.repeat(Buffer.byteLength(evil)))
    writeFileSync(join(work, 'analyze.py'), 'print(1)\n')
    const path = join(dir, 'evil.exe')
    samples = { dir, files: [{ path, name: 'evil.exe', bytes: Buffer.byteLength(evil), sha256: await sha256File(path) }] }
  })
  after(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  })

  const refusal = (file: string, ...args: string[]) => sampleExecRefusal(file, args, work, samples)
  const S = () => join(dir, 'evil.exe')

  it('refuse le programme qui est l\'échantillon, ou une copie identique', async () => {
    assert.match((await refusal(S())) ?? '', /program is the sample evil\.exe/)
    assert.match((await refusal(join(work, 'copy.bin'))) ?? '', /program is the sample evil\.exe/)
    assert.equal(await refusal(join(work, 'other.bin')), null, 'même taille, autre contenu : pas un échantillon')
  })

  it('refuse un chargeur, un émulateur ou un débogueur qui le reçoit', async () => {
    for (const loader of ['/usr/bin/wine64', 'C:\\Windows\\System32\\rundll32.exe', '/usr/bin/qemu-x86_64', '/usr/bin/gdb', '/opt/homebrew/bin/floss', '/usr/bin/strace']) {
      assert.match((await refusal(loader, S())) ?? '', /would run, load or emulate/, loader)
    }
    assert.match((await refusal('/usr/bin/wine', 'copy.bin')) ?? '', /evil\.exe/, 'une copie, désignée par un chemin relatif')
  })

  it('refuse un shell ou un interpréteur autre que Python qui le reçoit', async () => {
    assert.match((await refusal('/bin/bash', '-c', '"$0"', S())) ?? '', /bash is given the sample/)
    assert.match((await refusal('/usr/bin/node', 'reader.js', S())) ?? '', /node is given the sample/)
    assert.match((await refusal('C:\\Windows\\cmd.exe', '/c', S())) ?? '', /cmd is given the sample/)
  })

  it('refuse Python quand l\'échantillon est le script, ou passe à un module qui l\'exécute', async () => {
    assert.match((await refusal('/usr/bin/python3', S())) ?? '', /run the sample evil\.exe as its script/)
    assert.match((await refusal('/usr/bin/python3', '-W', 'ignore', S())) ?? '', /as its script/)
    assert.match((await refusal('/usr/bin/python3', '-m', 'floss', S())) ?? '', /python -m floss/)
    assert.match((await refusal('/usr/bin/python3', '-m', 'runpy', S())) ?? '', /python -m runpy/)
  })

  it('laisse passer ce qui le lit', async () => {
    assert.equal(await refusal('/usr/bin/python3', 'analyze.py', S()), null, 'un script d\'analyse qui le reçoit')
    assert.equal(await refusal('/usr/bin/python3', '-m', 'pefile', S()), null)
    assert.equal(await refusal('/usr/bin/python3', '-c', 'import sys; print(open(sys.argv[1],"rb").read(2))', S()), null)
    assert.equal(await refusal('/usr/bin/yara', '-s', 'rules.yar', S()), null)
    assert.equal(await refusal('/usr/bin/strings', S()), null)
    assert.equal(await refusal('/usr/bin/git', 'hash-object', S()), null)
    assert.equal(await sampleExecRefusal('/usr/bin/wine', [S()], work, undefined), null, 'sans échantillons, rien à garder')
  })

  it('exec refuse dans prepare, avant toute demande d\'approbation', async () => {
    const exec = findTool('exec')!
    const ctx: ToolContext = { root: work, httpPolicy: 'open', allowHosts: [], log: () => {}, writable: true, samples }
    await assert.rejects(
      exec.prepare!(exec.schema.parse({ command: './copy.bin' }) as never, ctx),
      /program is the sample evil\.exe/,
    )
  })
})

describe('le dossier des échantillons', () => {
  let home: string
  let src: string
  let config: HarnessConfig
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'midgaard-samples-home-'))
    src = realpathSync.native(mkdtempSync(join(tmpdir(), 'midgaard-samples-src-')))
    config = loadConfig({ MIDGAARD_HOME: home })
    writeFileSync(join(src, 'a.exe'), 'MZ sample a')
    writeFileSync(join(src, 'b.dll'), 'MZ sample b')
  })
  afterEach(() => {
    for (const d of [home, src]) {
      try {
        chmodTree(d)
      } catch {}
      rmSync(d, { recursive: true, force: true })
    }
  })

  /** Rouvre les droits d'un arbre, pour que le ménage du test passe. */
  function chmodTree(root: string): void {
    if (!existsSync(root)) return
    for (const name of readdirSync(root)) {
      const p = join(root, name)
      chmodSync(p, 0o755)
      if (statSync(p).isDirectory()) chmodTree(p)
    }
  }

  const ID = '00000000-0000-4000-8000-0000000000aa'

  async function staged(sources: string[], base: string | null = src): Promise<StagedSamples> {
    const r = await stageSamples(config, sources, base)
    if ('error' in r) throw new Error(r.error)
    return r
  }

  it('copie, nomme et empreinte, puis le dossier devient celui de la tâche', async () => {
    const s = await staged(['a.exe', join(src, 'b.dll')])
    assert.deepEqual(s.samples.map((x) => x.name), ['a.exe', 'b.dll'])
    assert.equal(s.samples[0]!.sha256, await sha256File(join(src, 'a.exe')))
    adoptStaged(config, s, ID)
    const v = await verifySamples(config, ID, s.samples)
    assert.ok('files' in v)
    assert.equal(v.files[0]!.path, realpathSync.native(join(taskSamplesDir(config, ID), 'a.exe')))
  })

  it('pose les copies et leur dossier en lecture seule', { skip: POSIX_ONLY }, async () => {
    const s = await staged(['a.exe'])
    adoptStaged(config, s, ID)
    const dir = taskSamplesDir(config, ID)
    assert.equal(statSync(join(dir, 'a.exe')).mode & 0o777, 0o444)
    assert.equal(statSync(dir).mode & 0o777, 0o555)
  })

  it('refuse ce qui ne doit pas devenir un échantillon, et ne laisse rien', async () => {
    writeFileSync(join(home, 'daemon.json'), '{"token":"secret"}')
    mkdirSync(join(src, 'dossier'))
    const cases: [string[], RegExp][] = [
      [[join(home, 'daemon.json')], /inside the Midgaard runtime folder/],
      [['absent.exe'], /not found/],
      [['dossier'], /not a regular file/],
      [Array.from({ length: 17 }, () => 'a.exe'), /at most 16/],
    ]
    for (const [sources, why] of cases) {
      const r = await stageSamples(config, sources, src)
      assert.ok('error' in r && why.test(r.error), `${sources[0]} : ${JSON.stringify(r)}`)
    }
    const relative = await stageSamples(config, ['a.exe'], null)
    assert.ok('error' in relative && /must be absolute/.test(relative.error))
    assert.deepEqual(existsSync(config.samplesDir) ? readdirSync(config.samplesDir) : [], [], 'aucun dossier préparé ne reste')
  })

  it('arrête au départ une copie modifiée ou disparue', async () => {
    const s = await staged(['a.exe', 'b.dll'])
    adoptStaged(config, s, ID)
    const dir = taskSamplesDir(config, ID)
    chmodSync(dir, 0o755)
    chmodSync(join(dir, 'a.exe'), 0o644)
    writeFileSync(join(dir, 'a.exe'), 'MZ autre chose')
    const changed = await verifySamples(config, ID, s.samples)
    assert.ok('error' in changed && /modifié depuis sa copie : a\.exe/.test(changed.error))
    rmSync(join(dir, 'b.dll'))
    const gone = await verifySamples(config, ID, s.samples.slice(1))
    assert.ok('error' in gone && /introuvable : b\.dll/.test(gone.error))
  })

  it('transmet par nom seulement les échantillons du parent, par lien', async () => {
    const parent = await staged(['a.exe', 'b.dll'])
    adoptStaged(config, parent, ID)
    const unknown = stageForwarded(config, ID, parent.samples, ['a.exe', '/etc/passwd'])
    assert.ok('error' in unknown && /unknown sample\(s\): \/etc\/passwd\. Your samples: a\.exe, b\.dll/.test(unknown.error))
    const child = stageForwarded(config, ID, parent.samples, ['b.dll'])
    assert.ok(!('error' in child))
    const CHILD = '00000000-0000-4000-8000-0000000000bb'
    adoptStaged(config, child, CHILD)
    assert.ok('files' in (await verifySamples(config, CHILD, child.samples)))
  })

  it('n\'efface que sous samplesDir, et balaie les dossiers orphelins ou finis', async () => {
    assert.throws(() => taskSamplesDir(config, '../../etc'), /identifiant de tâche invalide/)
    const store = HarnessStore.open(config)
    try {
      const s = await staged(['a.exe'])
      // Un dossier préparé que rien n'a adopté, et celui d'une tâche inconnue.
      await staged(['b.dll'])
      adoptStaged(config, s, ID)
      assert.equal(sweepSamples(config, store), 2)
      assert.deepEqual(readdirSync(config.samplesDir), [])
      const again = await staged(['a.exe'])
      adoptStaged(config, again, ID)
      removeTaskSamples(config, ID)
      assert.equal(existsSync(taskSamplesDir(config, ID)), false)
    } finally {
      store.close()
    }
  })
})

describe('les échantillons dans un vrai daemon', () => {
  let home: string
  let repo: string
  let src: string
  let daemon: Daemon
  let provider: FakeProvider
  let rt: RuntimeInfo
  let config: HarnessConfig

  const api = <T>(path: string, method = 'GET', body?: unknown) =>
    daemonJson<T & { error?: string; reason?: string }>(rt, path, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    })

  before(async () => {
    home = mkdtempSync(join(tmpdir(), 'midgaard-samples-daemon-'))
    repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'midgaard-samples-depot-')))
    src = realpathSync.native(mkdtempSync(join(tmpdir(), 'midgaard-samples-orig-')))
    writeFileSync(join(src, 'invoice.exe'), 'MZ the sample of the daemon tests')
    writeFileSync(join(src, 'loader.dll'), 'MZ a second sample')
    provider = await startFakeProvider()
    config = loadConfig({ MIDGAARD_HOME: home, MIDGAARD_PORT: '0' })
    daemon = (await startDaemon(config, {
      log: () => {},
      env: { MIDGAARD_VAULT: 'file', MIDGAARD_PROVIDER_API_KEY: 'sk-faux-samples', PATH: process.env.PATH ?? '' },
    }))!
    rt = readRuntime(config.runtimeFile)!
    daemon.store.upsertProvider({
      id: 'faux', name: 'faux', kind: 'openai-compatible', preset: 'custom', baseUrl: provider.url,
      defaultModel: 'faux-1', secretRef: null, webSearch: 'off',
    })
    reconcileAgents(daemon.store)
  })

  after(async () => {
    daemon.close('fin des tests')
    await daemon.stopped
    provider.server.close()
    for (const d of [home, repo, src]) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })

  const leftovers = () => (existsSync(config.samplesDir) ? readdirSync(config.samplesDir) : [])

  it('la route refuse un échantillon interdit ou un profil qui n\'en reçoit pas, sans rien laisser', async () => {
    const runtime = await api('/api/tasks', 'POST', {
      agent_id: RESEARCHER_AGENT_ID, objective: 'x', project_dir: repo, samples: [config.runtimeFile],
    })
    assert.equal(runtime.status, 400)
    assert.equal(runtime.body.error, 'invalid_samples')
    assert.match(runtime.body.reason ?? '', /runtime folder/)
    const simulated = await api('/api/tasks', 'POST', { agent_id: 'simulated', objective: 'x', samples: [join(src, 'invoice.exe')] })
    assert.equal(simulated.status, 409)
    assert.equal(simulated.body.error, 'samples_unsupported')
    assert.deepEqual(leftovers(), [], 'un refus efface le dossier préparé')
  })

  it('l\'agent reçoit les copies et la règle, la timeline les cite, la fin les efface', async () => {
    provider.scripts.set('[SM1]', [[{ tool: 'submit_result', args: { summary: 'lu' } }]])
    const created = await api<{ task: Task }>('/api/tasks', 'POST', {
      agent_id: RESEARCHER_AGENT_ID, objective: '[SM1] analyse', project_dir: repo, samples: [join(src, 'invoice.exe')],
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const id = created.body.task.id
    assert.deepEqual(created.body.task.samples.map((s) => s.name), ['invoice.exe'])
    const done = (await daemon.tasks.wait(id, 20_000, 0))!.task
    assert.equal(done.status, 'completed', done.error ?? '')

    const said = (provider.received.get('[SM1]') ?? []).map((m) => m.content ?? '').join('\n')
    const copy = join(realpathSync.native(config.samplesDir), id, 'invoice.exe')
    assert.ok(said.includes(copy), 'l\'agent lit le chemin de la copie')
    assert.match(said, /Never execute, load or emulate them/)
    assert.ok(!said.includes(join(src, 'invoice.exe')), 'jamais le chemin d\'origine')
    const notes = daemon.store.taskEvents(id).filter((e) => e.type === 'agent.message').map((e) => String(e.payload.message))
    assert.ok(notes.some((m) => /échantillons vérifiés, en lecture seule : invoice\.exe \(\d+ octets, sha256 [0-9a-f]{64}\)/.test(m)))
    assert.equal(existsSync(join(config.samplesDir, id)), false, 'les copies partent avec la tâche')
  })

  it('un orchestrateur ne transmet que ses échantillons, par nom', async () => {
    provider.scripts.set('[SM2]', [
      [{ tool: 'delegate_task', args: { agent_id: RESEARCHER_AGENT_ID, objective: '[SM2-x] lis', samples: [join(src, 'loader.dll')] } }],
      [{ tool: 'delegate_task', args: { agent_id: RESEARCHER_AGENT_ID, objective: '[SM2-enfant] lis', samples: ['loader.dll'] } }],
      [{ tool: 'wait_for_task', args: { task_id: '{{task_id}}' } }],
      [{ tool: 'submit_result', args: { summary: 'transmis' } }],
    ])
    provider.scripts.set('[SM2-enfant]', [[{ tool: 'submit_result', args: { summary: 'lu' } }]])
    const created = await api<{ task: Task }>('/api/tasks', 'POST', {
      agent_id: 'orchestrator', objective: '[SM2] confie', project_dir: repo,
      samples: [join(src, 'invoice.exe'), join(src, 'loader.dll')],
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const done = (await daemon.tasks.wait(created.body.task.id, 30_000, 0))!.task
    assert.equal(done.status, 'completed', done.error ?? '')

    const children = daemon.store.childTasks(created.body.task.id)
    assert.equal(children.length, 1, 'le chemin du disque est refusé, aucune sous-tâche créée pour lui')
    assert.deepEqual(children[0]!.samples.map((s) => s.name), ['loader.dll'])
    const refused = (provider.received.get('[SM2]') ?? []).map((m) => m.content ?? '').join('\n')
    assert.match(refused, /unknown sample\(s\)/)
    const childSaid = (provider.received.get('[SM2-enfant]') ?? []).map((m) => m.content ?? '').join('\n')
    assert.ok(childSaid.includes(join(realpathSync.native(config.samplesDir), children[0]!.id, 'loader.dll')))
    assert.deepEqual(leftovers(), [], 'parent et enfant finis : plus rien sous samplesDir')
  })
})
