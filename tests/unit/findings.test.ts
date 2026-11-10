/**
 * @file Les findings d'un arbre d'orchestrateur et la **porte de traçage**
 * (Slice 10, étape 2), sur un vrai daemon démarré dans le processus de test.
 *
 * Comme `created-agents.test.ts`, aucun modèle n'est appelé : les moteurs sont
 * pilotables, le gérant de tâches est le vrai, et chaque effet est lu **en
 * base** (ou au journal), pas à travers un client.
 *
 * Ce qui est prouvé, et pourquoi :
 *  - un finding naît `open`, et **seul `confirm` mène à `trace_confirmed`** —
 *    avec sa chaîne et son modèle de menace. Rien ne confirme par du texte ;
 *  - **`list('trace_confirmed')` ne rend que les confirmés** : un finding
 *    enregistré mais non confirmé n'apparaît jamais comme éligible au rapport.
 *    C'est la porte, lue directement ;
 *  - un finding **rejeté ne se confirme pas**, et un finding non `open` ne se
 *    rejette pas : la porte ne se contourne pas en rejugeant ;
 *  - un finding **n'appartient qu'à son arbre** : un autre orchestrateur ne le
 *    voit, ne le rejette ni ne le confirme ;
 *  - les champs d'un finding **passent par l'expurgation** avant d'être
 *    persistés, comme un objectif délégué ;
 *  - au bord de l'outil, `confirm_trace` **refuse une chaîne trop courte**, et
 *    les quatre outils **refusent sans port**.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { createRedactor, loadConfig, type AgentKind, type Finding, type Task } from '@midgaard/contracts'
import { MAX_FINDINGS, reconcileAgents, startDaemon, type Daemon, type EngineContext, type TaskEngine } from '@midgaard/daemon'
import { findTool, formatReport, type FindingsPort, type FindingsRefusal, type ToolContext } from '@midgaard/tools'

let home: string
let project: string
let daemon: Daemon
let ctx: EngineContext

/** Un moteur qui ne fait rien seul : le test écrit les transitions. */
function drivenEngine(kind: AgentKind): TaskEngine {
  return {
    kind,
    start: (task) => void ctx.bus.record(task.id, 'running', { type: 'task.started' }),
    resume: () => {},
    cancel: () => true,
    stop: () => {},
  }
}

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'midgaard-findings-'))
  project = realpathSync.native(mkdtempSync(join(tmpdir(), 'midgaard-findings-projet-')))
  const config = loadConfig({ MIDGAARD_HOME: home, MIDGAARD_PORT: '0' })
  daemon = (await startDaemon(config, { log: () => {}, env: { MIDGAARD_VAULT: 'file' } }))!
  ctx = daemon.tasks.engineContextFor()
  // Un fournisseur, pour que le profil orchestrateur soit activé.
  daemon.store.upsertProvider({
    id: 'venice', name: 'Venice', kind: 'openai-compatible', preset: 'venice', baseUrl: null,
    defaultModel: 'deepseek-v4-flash-0731', secretRef: null, webSearch: 'off',
  })
  reconcileAgents(daemon.store)
  for (const kind of ['orchestrator', 'researcher', 'developer'] as const) daemon.tasks.register(drivenEngine(kind))
})

after(async () => {
  daemon.close('fin des tests')
  await daemon.stopped
  rmSync(home, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
})

/** Une tâche orchestrateur en marche, et son port de findings. */
function orchestrator(secrets: string[] = []): { parent: Task; port: FindingsPort } {
  const created = daemon.tasks.create({
    objective: 'orchestre', agentId: 'orchestrator', context: null, projectDir: project, durationS: 20, needsApproval: false,
  })
  assert.ok(!('error' in created), JSON.stringify(created))
  return { parent: created.task, port: daemon.tasks.findingsFor(created.task.id, createRedactor(secrets)) }
}

function ok(result: Finding | FindingsRefusal): Finding {
  assert.ok(!('refused' in result), JSON.stringify(result))
  return result
}

function refused(result: Finding | FindingsRefusal, motive: RegExp): void {
  assert.ok('refused' in result, `attendu un refus, reçu ${JSON.stringify(result)}`)
  assert.match(result.refused, motive)
}

/** Un finding candidat complet, pour ne pas répéter les champs. */
const CANDIDATE = {
  title: 'Stack overflow in parse_header',
  vuln_class: 'stack-buffer-overflow',
  sink: 'src/fmt/hdr.c:42',
  source: 'net.c:88 (recv)',
  evidence: 'memcpy(buf, p, len) with len from the untrusted header',
}

const PATH = [
  { ref: 'net.c:88', note: 'len read from the socket' },
  { ref: 'hdr.c:42', note: 'len used as memcpy size into a 64-byte buffer' },
]

describe('le cycle de vie d\'un finding', () => {
  it('naît open, et seul confirm le mène à trace_confirmed, avec sa chaîne', () => {
    const { parent, port } = orchestrator()
    const f = ok(port.record(CANDIDATE))
    assert.equal(f.status, 'open')
    assert.equal(f.tree_task_id, parent.id, 'l\'arbre est posé par le daemon')
    assert.deepEqual(f.taint_path, [])

    const confirmed = ok(port.confirm(f.id, { threat_model: 'remote attacker sends a crafted packet', path: PATH }))
    assert.equal(confirmed.status, 'trace_confirmed')
    assert.equal(confirmed.taint_path.length, 2)
    assert.equal(confirmed.threat_model, 'remote attacker sends a crafted packet')

    // Le journal de la racine raconte les deux actes.
    const types = daemon.store.taskEvents(parent.id).map((e) => e.type)
    assert.ok(types.includes('finding.recorded'))
    assert.ok(types.includes('finding.trace_confirmed'))
  })

  it('la porte : list(trace_confirmed) ne rend QUE les confirmés', () => {
    const { parent, port } = orchestrator()
    const confirmed = ok(port.record(CANDIDATE))
    const open = ok(port.record({ ...CANDIDATE, title: 'un autre, pas tracé' }))
    const rejected = ok(port.record({ ...CANDIDATE, title: 'un faux positif' }))
    ok(port.confirm(confirmed.id, { threat_model: 'remote', path: PATH }))
    ok(port.reject(rejected.id, 'the length is clamped at hdr.c:38'))

    const eligible = port.list('trace_confirmed')
    assert.deepEqual(eligible.map((f) => f.id), [confirmed.id], 'seul le finding tracé est éligible au rapport')
    // Les non-confirmés existent, mais pas comme confirmés.
    assert.equal(port.list('open').map((f) => f.id).includes(open.id), true)
    assert.equal(port.list('trace_confirmed').some((f) => f.id === open.id), false)
    assert.equal(port.list().length, 3, 'les trois sont dans l\'arbre')
    void parent
  })

  it('un finding rejeté ne se confirme pas, et un finding non open ne se rejette pas', () => {
    const { port } = orchestrator()
    const f = ok(port.record(CANDIDATE))
    ok(port.reject(f.id, 'safe wrapper'))
    refused(port.confirm(f.id, { threat_model: 'x', path: PATH }), /was rejected and cannot be trace-confirmed/)

    const g = ok(port.record(CANDIDATE))
    ok(port.confirm(g.id, { threat_model: 'remote', path: PATH }))
    refused(port.reject(g.id, 'trop tard'), /is trace_confirmed, not open/)
  })

  it('n\'appartient qu\'à son arbre : un autre orchestrateur ne le voit pas', () => {
    const a = orchestrator()
    const b = orchestrator()
    const f = ok(a.port.record(CANDIDATE))
    refused(b.port.reject(f.id, 'vol'), /no finding .* belongs to your task/)
    refused(b.port.confirm(f.id, { threat_model: 'x', path: PATH }), /no finding .* belongs to your task/)
    assert.equal(b.port.list().length, 0, 'un autre arbre n\'en voit aucun')
  })

  it('expurge les champs avant de les persister', () => {
    const { port } = orchestrator(['sk-SECRET'])
    const f = ok(port.record({ ...CANDIDATE, evidence: 'token sk-SECRET leaked at auth.c:5' }))
    assert.ok(!f.evidence.includes('sk-SECRET'), 'l\'évidence est expurgée')
    const confirmed = ok(port.confirm(f.id, { threat_model: 'uses sk-SECRET', path: PATH }))
    assert.ok(!confirmed.threat_model!.includes('sk-SECRET'), 'le modèle de menace aussi')
  })

  it('refuse d\'enregistrer au-delà du plafond, et sur un arbre à l\'arrêt', () => {
    const { parent, port } = orchestrator()
    // Le plafond : on écrit directement en base jusqu'à la borne, puis l'outil refuse.
    for (let i = port.list().length; i < MAX_FINDINGS; i++) {
      daemon.store.recordFinding({ id: randomUUID(), tree_task_id: parent.id, ...CANDIDATE })
    }
    refused(port.record(CANDIDATE), new RegExp(`already recorded ${MAX_FINDINGS} findings`))

    const b = orchestrator()
    daemon.tasks.cancel(b.parent.id, 'stop')
    refused(b.port.record(CANDIDATE), /your task is stopping/)
  })
})

describe('la couche outils', () => {
  /** Un contexte minimal sans port de findings. */
  const noPort = { root: project, httpPolicy: 'approval', allowHosts: [], log() {} } as unknown as ToolContext

  it('les cinq outils refusent sans ToolContext.findings', () => {
    for (const name of ['record_finding', 'reject_finding', 'confirm_trace', 'list_findings', 'compile_report']) {
      const tool = findTool(name)!
      assert.equal(tool.policy({} as never, noPort).decision, 'deny', `${name} doit refuser sans port`)
    }
  })

  it('confirm_trace refuse une chaîne de moins de deux pas', () => {
    const schema = findTool('confirm_trace')!.schema
    const tooShort = { finding_id: randomUUID(), threat_model: 'x', path: [{ ref: 'a:1', note: 'n' }] }
    assert.equal(schema.safeParse(tooShort).success, false, 'un seul pas : refusé au bord de l\'outil')
    const full = { finding_id: randomUUID(), threat_model: 'x', path: PATH }
    assert.equal(schema.safeParse(full).success, true)
  })
})

describe('le rapport déterministe (compile_report)', () => {
  const at = '2026-11-10T10:00:00.000Z'
  const F: Finding = {
    id: '00000000-0000-4000-8000-0000000000aa',
    tree_task_id: '00000000-0000-4000-8000-0000000000bb',
    title: 'Stack overflow in parse_header',
    vuln_class: 'stack-buffer-overflow',
    sink: 'src/fmt/hdr.c:42',
    source: 'net.c:88',
    evidence: 'memcpy(buf, p, len)\nlen from the header',
    status: 'trace_confirmed',
    reject_reason: null,
    threat_model: 'remote attacker sends a crafted packet',
    taint_path: PATH,
    created_at: at,
    updated_at: at,
  }

  it('markdown : titre, source→sink, chaîne, évidence', () => {
    const md = formatReport([F], 'markdown')
    assert.match(md, /1 trace-confirmed finding/)
    assert.match(md, /## 1\. Stack overflow in parse_header/)
    assert.match(md, /\*\*Sink:\*\* src\/fmt\/hdr\.c:42/)
    assert.match(md, /1\. `net\.c:88` — len read from the socket/)
    assert.ok(md.includes('memcpy(buf, p, len)'), 'l\'évidence est citée')
  })

  it('json : le compte et les champs, parsable', () => {
    const parsed = JSON.parse(formatReport([F], 'json')) as { count: number; findings: { sink: string; taint_path: unknown[] }[] }
    assert.equal(parsed.count, 1)
    assert.equal(parsed.findings[0]!.sink, 'src/fmt/hdr.c:42')
    assert.equal(parsed.findings[0]!.taint_path.length, 2)
  })

  it('sarif : 2.1.0 valide, un résultat, règle et localisation du sink', () => {
    const sarif = JSON.parse(formatReport([F], 'sarif')) as {
      version: string
      runs: { results: { ruleId: string; locations: { physicalLocation: { artifactLocation: { uri: string }; region?: { startLine: number } } }[] }[] }[]
    }
    assert.equal(sarif.version, '2.1.0')
    const result = sarif.runs[0]!.results[0]!
    assert.equal(result.ruleId, 'stack-buffer-overflow')
    assert.equal(result.locations[0]!.physicalLocation.artifactLocation.uri, 'src/fmt/hdr.c')
    assert.equal(result.locations[0]!.physicalLocation.region?.startLine, 42)
  })

  it('déterministe : à findings égaux, sortie égale', () => {
    assert.equal(formatReport([F], 'sarif'), formatReport([F], 'sarif'))
    assert.equal(formatReport([], 'markdown'), formatReport([], 'markdown'))
    assert.match(formatReport([], 'markdown'), /0 trace-confirmed finding/)
  })

  it('l\'outil n\'inclut QUE les findings tracés de l\'arbre', async () => {
    const { parent, port } = orchestrator()
    const confirmed = ok(port.record(CANDIDATE))
    ok(port.record({ ...CANDIDATE, title: 'pas tracé' })) // reste open
    ok(port.confirm(confirmed.id, { threat_model: 'remote', path: PATH }))
    const ctx = { root: project, httpPolicy: 'approval', allowHosts: [], findings: port, log() {} } as unknown as ToolContext
    const out = await findTool('compile_report')!.run({ format: 'markdown' } as never, ctx)
    assert.match(out.content, /1 trace-confirmed finding/, 'un seul finding tracé')
    assert.ok(!out.content.includes('pas tracé'), 'un finding non tracé n\'apparaît pas')
    assert.equal(out.untrusted, true)
    void parent
  })
})
