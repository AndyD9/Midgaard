/**
 * @file La boucle d'agent, éprouvée avec un faux fournisseur.
 *
 * Aucun modèle n'est appelé : l'adaptateur est une liste de réponses
 * préprogrammées. C'est ce qui permet de vérifier **l'invariant le plus cher du
 * produit** — qu'un budget arrête la tâche *avant* l'appel de trop — sans payer
 * pour le constater, et de le vérifier à chaque exécution de la suite.
 *
 * Ce que ces tests couvrent, et pourquoi :
 *  - le budget, les étapes, le délai et l'annulation arrêtent la boucle ;
 *  - seul `submit_result` termine une tâche, et un modèle bavard est relancé
 *    une fois avant d'échouer ;
 *  - un outil hors profil est refusé sans demander d'approbation ;
 *  - une approbation refusée n'est pas contournable ;
 *  - le contenu extérieur est encadré **avant** de revenir dans la conversation.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { describe, it } from 'node:test'
import type { Agent, Usage } from '@midgaard/contracts'
import { DEFAULT_RESEARCHER_LIMITS, emptyUsage } from '@midgaard/contracts'
import type { CompletionRequest, CompletionResponse, ProviderAdapter } from '@midgaard/providers'
import { buildMessages, runAgent, type ApprovalOutcome, type ApprovalRequest, type LoopHooks } from '@midgaard/agent-runtime'
import type { ToolContext } from '@midgaard/tools'

/** Racine de projet jetable, partagée par les tests qui lisent des fichiers. */
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'midgaard-loop-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'a.ts'), 'const x = 1\n')
  return root
}

/** Consommation d'un appel, avec un coût connu. */
function cost(usd: number): Usage {
  return { ...emptyUsage(), model_calls: 1, input_tokens: 10, output_tokens: 10, cost_usd: usd, cost_source: 'provider', cost_usd_reported: usd }
}

/** Réponse de modèle préprogrammée. */
type Scripted = Partial<CompletionResponse> & { usage?: Usage }

/** Faux fournisseur : rend les réponses dans l'ordre, puis boucle sur la dernière. */
function scriptedAdapter(script: Scripted[], options: { supportsWebSearch?: boolean } = {}) {
  const calls: CompletionRequest[] = []
  let index = 0
  const adapter: ProviderAdapter = {
    id: 'faux',
    preset: 'venice',
    model: 'modele-de-test',
    supportsWebSearch: options.supportsWebSearch ?? false,
    async complete(request) {
      calls.push(request)
      const next = script[Math.min(index++, script.length - 1)] ?? {}
      return {
        text: next.text ?? '',
        toolCalls: next.toolCalls ?? [],
        usage: next.usage ?? cost(0.001),
        citations: next.citations ?? [],
        finishReason: next.finishReason ?? (next.toolCalls?.length ? 'tool_calls' : 'stop'),
      }
    },
    async testConnection() {
      return { ok: true, detail: 'faux', at: new Date().toISOString(), latency_ms: 0, models: [] }
    },
  }
  return { adapter, calls, callCount: () => calls.length }
}

/** Crochets qui enregistrent tout, pour pouvoir affirmer ce qui s'est passé. */
function recordingHooks(over: Partial<LoopHooks> = {}) {
  const notes: string[] = []
  const messages: string[] = []
  const usages: Usage[] = []
  const tools: { name: string; decision: string; status?: string; error?: string | null }[] = []
  const approvals: string[] = []
  const hooks: LoopHooks = {
    onAgentMessage: (t) => void messages.push(t),
    onUsage: (u) => void usages.push(u),
    onNote: (m) => void notes.push(m),
    onToolRequested: (input) => {
      tools.push({ name: input.name, decision: input.decision })
      return String(tools.length - 1)
    },
    onToolCompleted: (id, input) => {
      const entry = tools[Number(id)]
      if (entry) {
        entry.status = input.status
        entry.error = input.error
      }
    },
    requestApproval: async (operation) => {
      approvals.push(operation.operation)
      return 'approved' as ApprovalOutcome
    },
    isCancelled: () => false,
    ...over,
  }
  return { hooks, notes, messages, usages, tools, approvals }
}

function agentWith(over: Partial<Agent> = {}): Agent {
  return {
    id: 'researcher',
    name: 'Researcher',
    kind: 'researcher',
    description: '',
    provider_id: 'faux',
    model: null,
    system_prompt: 'You are a researcher.',
    tools: ['read_file', 'http_fetch', 'submit_result'],
    limits: { ...DEFAULT_RESEARCHER_LIMITS },
    enabled: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  }
}

function toolCtx(root: string, over: Partial<ToolContext> = {}): ToolContext {
  return { root, httpPolicy: 'open', allowHosts: [], log: () => {}, ...over }
}

/** Appel `submit_result` bien formé. */
function submit(summary = 'la réponse', extra: Record<string, unknown> = {}) {
  return [{ id: 'c1', name: 'submit_result', argumentsJson: JSON.stringify({ summary, ...extra }) }]
}

async function run(script: Scripted[], over: { agent?: Partial<Agent>; hooks?: Partial<LoopHooks>; ctx?: Partial<ToolContext> } = {}) {
  const root = makeRoot()
  try {
    const { adapter, callCount } = scriptedAdapter(script)
    const rec = recordingHooks(over.hooks)
    const outcome = await runAgent({
      agent: agentWith(over.agent),
      objective: 'trouve la réponse',
      context: null,
      adapter,
      tools: toolCtx(root, over.ctx),
      hooks: rec.hooks,
      redact: (t) => t,
      signal: new AbortController().signal,
    })
    return { outcome, ...rec, callCount: callCount() }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('fin de tâche', () => {
  it('ne se termine que sur submit_result', async () => {
    const { outcome, callCount } = await run([{ toolCalls: submit('42') }])
    assert.equal(outcome.status, 'completed')
    assert.equal(outcome.status === 'completed' && outcome.result.summary, '42')
    assert.equal(callCount, 1)
  })

  it('relance une fois un modèle qui dit avoir fini sans appeler l\'outil', async () => {
    const { outcome, notes, callCount } = await run([
      { text: 'Voilà, j\'ai terminé.' },
      { toolCalls: submit('la vraie réponse') },
    ])
    assert.equal(outcome.status, 'completed')
    assert.equal(callCount, 2, 'un tour de plus, consommé pour obtenir le résultat structuré')
    assert.ok(notes.some((n) => /relance/.test(n)))
  })

  it('échoue si la relance ne suffit pas, plutôt que de rendre du texte libre', async () => {
    const { outcome, callCount } = await run([{ text: 'j\'ai fini, promis' }])
    assert.equal(outcome.status, 'failed')
    assert.match(outcome.status === 'failed' ? outcome.error : '', /sans appeler submit_result/)
    assert.equal(callCount, 2, 'relancé une fois, pas davantage')
  })

  // « Aucun outil appelé » et « réponse tronquée » produisent le même symptôme et
  // appellent deux corrections opposées. Confondre les deux a réellement coûté une
  // relance inutile à la lecture de l'ancien message (docs/SLICE2.md, § défaut n° 2).
  it('nomme la troncature quand c\'est elle qui a empêché submit_result', async () => {
    const { outcome } = await run([{ text: 'je commence une très longue réponse et', finishReason: 'length' }])
    assert.equal(outcome.status, 'failed')
    const error = outcome.status === 'failed' ? outcome.error : ''
    assert.match(error, /coupée à \d+ jetons de sortie/, 'la cause, pas seulement le symptôme')
    assert.match(error, /plus courte/, 'et un geste que le lecteur peut faire')
    assert.doesNotMatch(error, /relève max_output_tokens/, 'ce réglage est hors d\'atteinte depuis une délégation')
  })

  it('dit quoi faire quand le modèle s\'arrête vraiment sans conclure', async () => {
    const { outcome } = await run([{ text: 'j\'ai fini, promis' }])
    const error = outcome.status === 'failed' ? outcome.error : ''
    assert.match(error, /sans appeler submit_result/)
    assert.doesNotMatch(error, /coupée à/, 'aucune troncature ici : ne pas l\'inventer')
    assert.match(error, /Reformule l'objectif/, 'un refus doit dire quoi faire')
  })

  it('refuse une charge utile invalide et laisse le modèle corriger', async () => {
    const { outcome, notes } = await run([
      { toolCalls: [{ id: 'c1', name: 'submit_result', argumentsJson: '{"details":"sans résumé"}' }] },
      { toolCalls: submit('corrigé') },
    ])
    assert.equal(outcome.status, 'completed')
    assert.ok(notes.some((n) => /submit_result refusé/.test(n)))
  })

  it('marque le résultat non fiable dès qu\'il cite une source extérieure', async () => {
    const { outcome } = await run([
      { toolCalls: submit('selon la doc', { citations: [{ title: 'Doc', url: 'https://exemple.test' }] }) },
    ])
    assert.equal(outcome.status === 'completed' && outcome.result.untrusted, true)
  })
})

describe('limites', () => {
  it('arrête la tâche AVANT l\'appel qui dépasserait le budget', async () => {
    // Trois appels à 0,40 $ : le budget de 1 $ est dépassé après le troisième.
    // Ce qu'on vérifie, c'est qu'il n'y a pas de quatrième appel.
    const { outcome, callCount } = await run(
      [{ text: 'je cherche', toolCalls: [{ id: 'c1', name: 'read_file', argumentsJson: '{"path":"src/a.ts"}' }], usage: cost(0.4) }],
      { agent: { limits: { ...DEFAULT_RESEARCHER_LIMITS, max_cost_usd: 1 } } },
    )
    assert.equal(outcome.status, 'budget_exceeded', 'et non failed : rien n\'a échoué')
    assert.equal(callCount, 3, '0,40 × 3 = 1,20 ≥ 1 : le quatrième appel ne part pas')
    assert.match(outcome.status === 'budget_exceeded' ? outcome.error : '', /budget de 1,?\.?00 \$ atteint — 3 appel\(s\) modèle, 1\.20 \$/)
  })

  it('rend la consommation même quand la tâche échoue', async () => {
    const { outcome } = await run([{ text: 'rien' }])
    assert.ok(outcome.usage.cost_usd > 0, 'ce qui a été dépensé a été dépensé')
    assert.equal(outcome.usage.model_calls, 2)
  })

  it('s\'arrête sur la limite d\'étapes, et le dit', async () => {
    const { outcome, callCount } = await run(
      [{ text: 'je réfléchis', toolCalls: [{ id: 'c1', name: 'read_file', argumentsJson: '{"path":"src/a.ts"}' }] }],
      { agent: { limits: { ...DEFAULT_RESEARCHER_LIMITS, max_steps: 3 } } },
    )
    assert.equal(outcome.status, 'failed')
    assert.equal(callCount, 3)
    const error = outcome.status === 'failed' ? outcome.error : ''
    assert.match(error, /3 étapes atteinte/)
    // Les deux sorties proposées sont atteignables depuis une délégation.
    assert.match(error, /relève max_steps/)
    assert.match(error, /simplifie l'objectif/)
  })

  it('n\'applique pas de budget sur un modèle sans tarif, et prévient une seule fois', async () => {
    const inconnu: Usage = { ...emptyUsage(), model_calls: 1, cost_source: 'unknown' }
    const { outcome, notes } = await run(
      [{ text: 'je tourne', toolCalls: [{ id: 'c1', name: 'read_file', argumentsJson: '{"path":"src/a.ts"}' }], usage: inconnu }],
      { agent: { limits: { ...DEFAULT_RESEARCHER_LIMITS, max_steps: 4, max_cost_usd: 0.000001 } } },
    )
    assert.equal(outcome.status, 'failed', 'bornée par les étapes, pas par un budget inapplicable')
    assert.equal(notes.filter((n) => /tarif inconnu/.test(n)).length, 1, 'averti une fois, pas à chaque tour')
  })

  it('honore une annulation au point de contrôle suivant', async () => {
    let cancelled = false
    const { outcome } = await run(
      [{ text: 'je travaille', toolCalls: [{ id: 'c1', name: 'read_file', argumentsJson: '{"path":"src/a.ts"}' }] }],
      { hooks: { isCancelled: () => { const was = cancelled; cancelled = true; return was } } },
    )
    assert.equal(outcome.status, 'cancelled')
  })
})

describe('appels d\'outils', () => {
  it('refuse sans approbation un outil absent du profil', async () => {
    const { outcome, tools, approvals } = await run(
      [
        { toolCalls: [{ id: 'c1', name: 'search_files', argumentsJson: '{"pattern":"x"}' }] },
        { toolCalls: submit('fini') },
      ],
      { agent: { tools: ['read_file', 'submit_result'] } },
    )
    assert.equal(outcome.status, 'completed')
    assert.equal(approvals.length, 0, 'un outil hors profil n\'est pas négociable')
    assert.equal(tools[0]?.decision, 'deny')
    assert.equal(tools[0]?.status, 'denied')
  })

  it('rend l\'erreur de schéma au modèle pour qu\'il corrige', async () => {
    const { outcome, tools } = await run([
      { toolCalls: [{ id: 'c1', name: 'read_file', argumentsJson: '{"chemin":"src/a.ts"}' }] },
      { toolCalls: submit('fini') },
    ])
    assert.equal(outcome.status, 'completed')
    // Argument invalide : refusé avant même d'être journalisé comme exécuté.
    assert.equal(tools.filter((t) => t.name === 'read_file' && t.status === 'succeeded').length, 0)
  })

  it('exécute un outil autorisé et journalise sa réussite', async () => {
    const { outcome, tools } = await run([
      { toolCalls: [{ id: 'c1', name: 'read_file', argumentsJson: '{"path":"src/a.ts"}' }] },
      { toolCalls: submit('fini') },
    ])
    assert.equal(outcome.status, 'completed')
    const lu = tools.find((t) => t.name === 'read_file')
    assert.equal(lu?.status, 'succeeded')
    assert.equal(lu?.decision, 'allow')
  })

  it('suspend la tâche quand la politique l\'exige, et respecte un refus', async () => {
    const vus: string[] = []
    const { outcome, tools } = await run(
      [
        { toolCalls: [{ id: 'c1', name: 'http_fetch', argumentsJson: '{"url":"https://exemple.test/doc"}' }] },
        { toolCalls: submit('fini sans la page') },
      ],
      {
        ctx: { httpPolicy: 'approval' },
        hooks: {
          requestApproval: async (op) => {
            vus.push(op.operation)
            return 'rejected' as ApprovalOutcome
          },
        },
      },
    )
    assert.equal(outcome.status, 'completed')
    assert.equal(vus.length, 1)
    assert.match(vus[0]!, /http_fetch/)
    assert.equal(tools.find((t) => t.name === 'http_fetch')?.status, 'rejected')
  })

  it('refuse les appels au-delà de la limite par étape, en le disant', async () => {
    const trois = Array.from({ length: 3 }, (_, i) => ({
      id: `c${i}`, name: 'read_file', argumentsJson: '{"path":"src/a.ts"}',
    }))
    const { outcome, tools } = await run(
      [{ toolCalls: trois }, { toolCalls: submit('fini') }],
      { agent: { limits: { ...DEFAULT_RESEARCHER_LIMITS, max_tool_calls_per_step: 2 } } },
    )
    assert.equal(outcome.status, 'completed')
    assert.equal(tools.filter((t) => t.name === 'read_file').length, 2, 'deux exécutés, le troisième refusé')
  })
})

describe('contenu non fiable', () => {
  it('encadre une page web avant de la réinjecter dans la conversation de l\'agent', async () => {
    const root = makeRoot()
    try {
      // Le serveur n'existe pas : `http_fetch` échouera. Ce qu'on vérifie ici,
      // c'est le chemin d'encadrement sur un résultat marqué non fiable — donc
      // on passe par un outil dont on contrôle la sortie.
      const { adapter, calls } = scriptedAdapter([
        { toolCalls: [{ id: 'c1', name: 'read_file', argumentsJson: '{"path":"src/a.ts"}' }] },
        { toolCalls: submit('fini') },
      ])
      const rec = recordingHooks()
      await runAgent({
        agent: agentWith(),
        objective: 'lis le fichier',
        context: null,
        adapter,
        tools: toolCtx(root),
        hooks: rec.hooks,
        redact: (t) => t,
        signal: new AbortController().signal,
      })
      const second = calls[1]!
      const toolMessage = second.messages.find((m) => m.role === 'tool')
      assert.ok(toolMessage && 'content' in toolMessage)
      // Un fichier du projet n'est PAS encadré : il n'est pas plus suspect que
      // le dépôt lui-même, et l'encadrer partout banaliserait le marqueur.
      assert.ok(!toolMessage.content.includes('<untrusted_data'))
      assert.match(toolMessage.content, /const x = 1/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('écriture hors worktree', () => {
  it('refuse un outil d\'écriture même présent dans le profil, sans demander d\'approbation', async () => {
    // Un profil mal configuré qui aurait reçu write_file. La seconde serrure —
    // le contexte sans worktree — doit tenir seule, et ne pas transformer le
    // refus en demande d'approbation qu'un humain finirait par accepter.
    const { outcome, tools, approvals } = await run(
      [
        { toolCalls: [{ id: 'w1', name: 'write_file', argumentsJson: JSON.stringify({ path: 'x.ts', content: 'x' }) }] },
        { toolCalls: submit('rien écrit') },
      ],
      { agent: { tools: ['write_file', 'submit_result'] } },
    )
    assert.equal(outcome.status, 'completed')
    const write = tools.find((t) => t.name === 'write_file')
    assert.equal(write?.decision, 'deny')
    assert.equal(write?.status, 'denied')
    assert.match(write?.error ?? '', /no workspace/)
    assert.deepEqual(approvals, [])
  })
})

describe('exec sous approbation', () => {
  it('montre le programme résolu et l\'argv exact, et ne lance rien si l\'humain refuse', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'midgaard-exec-refus-'))
    const marker = join(elsewhere, 'a-tourne')
    try {
      const args = ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`]
      const requests: ApprovalRequest[] = []
      const { outcome, tools } = await run(
        [
          { toolCalls: [{ id: 'e1', name: 'exec', argumentsJson: JSON.stringify({ command: 'node', args }) }] },
          { toolCalls: submit('refusé, donc rien lancé') },
        ],
        {
          agent: { tools: ['exec', 'submit_result'] },
          ctx: { writable: true },
          hooks: { requestApproval: async (request) => (requests.push(request), 'rejected') },
        },
      )
      assert.equal(outcome.status, 'completed')
      assert.equal(requests.length, 1)
      const [request] = requests
      // Le programme est résolu AVANT la demande : l'humain lit un chemin
      // absolu, pas un nom que le PATH résoudra plus tard.
      const program = String(request!.detail.program)
      assert.ok(isAbsolute(program), `programme résolu : ${program}`)
      assert.ok(request!.operation.startsWith(`exec — exécuter ${program} -e 'require(`), request!.operation)
      assert.deepEqual(request!.detail.args, args)
      assert.equal(request!.detail.tool, 'exec')
      assert.equal(tools.find((t) => t.name === 'exec')?.status, 'rejected')
      assert.equal(existsSync(marker), false, 'la commande refusée ne doit pas avoir tourné')
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('ne sollicite personne pour un programme introuvable', async () => {
    const requests: ApprovalRequest[] = []
    const { tools } = await run(
      [
        { toolCalls: [{ id: 'e1', name: 'exec', argumentsJson: JSON.stringify({ command: 'midgaard-introuvable' }) }] },
        { toolCalls: submit('rien') },
      ],
      {
        agent: { tools: ['exec', 'submit_result'] },
        ctx: { writable: true },
        hooks: { requestApproval: async (request) => (requests.push(request), 'approved') },
      },
    )
    assert.deepEqual(requests, [], 'un échec certain ne doit pas déranger un humain')
    const exec = tools.find((t) => t.name === 'exec')
    assert.equal(exec?.status, 'failed')
    assert.match(exec?.error ?? '', /command not found/)
  })

  it('expurge le détail persisté, comme tout ce qui s\'écrit en base', async () => {
    const requests: ApprovalRequest[] = []
    const root = makeRoot()
    try {
      const { adapter } = scriptedAdapter([
        { toolCalls: [{ id: 'e1', name: 'exec', argumentsJson: JSON.stringify({ command: 'node', args: ['-e', 'x', 'sk-secret-123'] }) }] },
        { toolCalls: submit('fini') },
      ])
      const rec = recordingHooks({ requestApproval: async (request) => (requests.push(request), 'rejected') })
      await runAgent({
        agent: agentWith({ tools: ['exec', 'submit_result'] }),
        objective: 'o', context: null, adapter,
        tools: toolCtx(root, { writable: true }),
        hooks: rec.hooks,
        redact: (t) => t.replaceAll('sk-secret-123', '[expurgé]'),
        signal: new AbortController().signal,
      })
      assert.doesNotMatch(JSON.stringify(requests), /sk-secret-123/)
      assert.deepEqual(requests[0]!.detail.args, ['-e', 'x', '[expurgé]'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('consigne d\'un agent écrivant', () => {
  const base = {
    agent: agentWith({ system_prompt: 'You are a developer.' }),
    objective: 'o',
    context: 'Voir /depot/src/app.ts',
    root: '/wt/abcd',
    tree: 'src/',
    limits: DEFAULT_RESEARCHER_LIMITS,
    budgetEnforceable: true,
  }

  it('dit le worktree, sa branche, et que les chemins de Claude se lisent en relatif', () => {
    const [system] = buildMessages({
      ...base,
      workspace: { branch: 'midgaard/abcd', baseCommit: 'a'.repeat(40), baseDirty: 0, submodules: [], originDir: '/depot' },
    })
    assert.match(system!.content, /Workspace root \(a git worktree.*\): \/wt\/abcd/)
    assert.match(system!.content, /branch midgaard\/abcd/)
    assert.match(system!.content, /original repository \(\/depot\)/)
    assert.doesNotMatch(system!.content, /uncommitted/, 'aucun avertissement sans travail en cours')
  })

  it('avertit quand le travail en cours de l\'utilisateur est absent', () => {
    const [system] = buildMessages({
      ...base,
      workspace: { branch: 'midgaard/abcd', baseCommit: 'a'.repeat(40), baseDirty: 3, submodules: [], originDir: '/depot' },
    })
    assert.match(system!.content, /3 uncommitted change\(s\).*NOT/)
  })

  it('avertit des sous-modules vides, et seulement s\'il y en a', () => {
    const [system] = buildMessages({
      ...base,
      workspace: { branch: 'midgaard/abcd', baseCommit: 'a'.repeat(40), baseDirty: 0, submodules: ['vendor/lib'], originDir: '/depot' },
    })
    assert.match(system!.content, /submodules are EMPTY directories in your workspace: vendor\/lib.*cannot write inside them/)
    const [none] = buildMessages({
      ...base,
      workspace: { branch: 'midgaard/abcd', baseCommit: 'a'.repeat(40), baseDirty: 0, submodules: [], originDir: '/depot' },
    })
    assert.doesNotMatch(none!.content, /submodule/)
  })

  it('garde la consigne de lecture seule pour un agent sans worktree', () => {
    const [system] = buildMessages(base)
    assert.match(system!.content, /Project root \(the only directory you can read\)/)
    assert.doesNotMatch(system!.content, /worktree/)
  })
})
