/**
 * @file L'atelier du dashboard (Slice 6, étape 6) : les fonctions pures du fil,
 * du terminal et de l'explorateur, sans rendu.
 *
 * Ce qui pourrait mentir à l'écran sans qu'aucun rendu ne le montre :
 *  - **le terminal ne laisse passer que les couleurs** d'une sortie de
 *    commande : une séquence qui efface l'écran ou réécrit une ligne ferait
 *    voir à l'humain autre chose que ce qui s'est passé, au moment même où il
 *    décide d'une approbation ;
 *  - **le fil suit l'ordre du journal** et dit qui parle à qui, sans inventer
 *    d'élément — les notes du harness n'y entrent pas ;
 *  - **la saisie ne s'ouvre que lorsque la conversation attend** l'utilisateur ;
 *  - l'arbre de fichiers ne perd aucune entrée, même coupé.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_RESEARCHER_LIMITS, emptyUsage, type Task, type TaskEvent } from '@midgaard/contracts'
import { buildThread, composerState } from '../../apps/dashboard/src/lib/thread.ts'
import { buildTerminal, sanitizeOutput } from '../../apps/dashboard/src/lib/terminal.ts'
import { buildFileTree, languageFor, lastWrittenPath } from '../../apps/dashboard/src/lib/files.ts'

const ROOT = '00000000-0000-4000-8000-000000000001'
const CHILD = '00000000-0000-4000-8000-000000000002'

/** Une tâche minimale. */
function task(id: string, over: Partial<Task> = {}): Task {
  const at = '2026-11-03T10:00:00.000Z'
  return {
    id, objective: 'objectif', status: 'running', step: 0, steps_total: 1, agent_id: 'orchestrator', context: null,
    project_dir: '/p', parent_task_id: null, mode: 'chat', awaiting_input: null, limits: DEFAULT_RESEARCHER_LIMITS,
    usage: emptyUsage(), needs_approval: false, approval_seq: 0, duration_s: 1, created_at: at, updated_at: at,
    started_at: null, ended_at: null, result: null, error: null, ...over,
  }
}

let seq = 0
/** Un événement, numéroté dans l'ordre d'écriture. */
function ev(taskId: string, type: TaskEvent['type'], payload: Record<string, unknown> = {}, status: Task['status'] = 'running'): TaskEvent {
  seq++
  return { seq, task_seq: seq, task_id: taskId, type, at: '2026-11-03T10:00:00.000Z', status, payload }
}

describe('terminal : nettoyage de la sortie', () => {
  it('garde le texte, les couleurs, les retours à la ligne et les tabulations', () => {
    assert.equal(sanitizeOutput('\x1b[32mok\x1b[0m\tfin\r\n'), '\x1b[32mok\x1b[0m\tfin\r\n')
  })

  it('retire ce qui efface, déplace le curseur ou réécrit une ligne', () => {
    // Effacer l'écran, remonter d'une ligne, se placer en 1;1, effacer la ligne.
    const forged = 'vraie sortie\n\x1b[2J\x1b[1A\x1b[1;1H\x1b[2Kfausse ligne'
    assert.equal(sanitizeOutput(forged), 'vraie sortie\nfausse ligne')
  })

  it('retire les séquences OSC (titre, presse-papiers, lien) et la cloche', () => {
    assert.equal(sanitizeOutput('a\x1b]0;titre\x07b\x1b]52;c;ZXZpbA==\x07c\x1b]8;;https://x\x1b\\d\x07'), 'abcd')
  })

  it('retire les autres séquences ESC et les contrôles restants', () => {
    assert.equal(sanitizeOutput('a\x1bcb\x1b7c\x00d\x7fe'), 'abcde')
  })

  it('compose une commande, sa sortie et sa fin, et nettoie aussi la ligne de commande', () => {
    seq = 0
    const events = {
      [CHILD]: [
        ev(CHILD, 'tool.requested', { tool_call_id: 't1', name: 'exec', decision: 'approval', arguments: JSON.stringify({ command: 'npm', args: ['test', '\x1b[2J'] }) }),
        ev(CHILD, 'exec.output', { tool_call_id: 't1', stream: 'stdout', text: 'ok\n' }),
        ev(CHILD, 'exec.output', { tool_call_id: 't1', stream: 'stderr', text: 'avert\n' }),
        ev(CHILD, 'tool.completed', { tool_call_id: 't1', status: 'succeeded', summary: 'code 0' }),
        // Une autre commande que `exec` n'apparaît pas.
        ev(CHILD, 'tool.requested', { tool_call_id: 't2', name: 'read_file', arguments: '{}' }),
      ],
    }
    const text = buildTerminal([{ taskId: CHILD, label: 'Developer · 2' }], events).map((c) => c.text).join('')
    assert.match(text, /Developer · 2.*\$.*npm test/)
    assert.match(text, /sous approbation/)
    assert.doesNotMatch(text, /\x1b\[2J/, 'la séquence glissée dans un argument est retirée aussi')
    assert.match(text, /ok\n/)
    assert.match(text, /\x1b\[31mavert\n/, 'la sortie d’erreur en rouge')
    assert.match(text, /code 0/)
    assert.doesNotMatch(text, /read_file/)
  })
})

describe('fil d’un arbre', () => {
  it('raconte qui dit quoi à qui, dans l’ordre du journal, sans les notes du harness', () => {
    seq = 0
    const root = task(ROOT, { objective: 'aide-moi' })
    const child = task(CHILD, { agent_id: 'developer', parent_task_id: ROOT, objective: 'ajoute /health', mode: 'review' })
    const events = {
      [ROOT]: [ev(ROOT, 'task.created')],
      [CHILD]: [] as TaskEvent[],
    }
    events[CHILD].push(ev(CHILD, 'task.created'))
    events[ROOT].push(ev(ROOT, 'agent.message', { message: 'relance', note: true }))
    events[CHILD].push(ev(CHILD, 'input.requested', { request: 'proposal', text: 'route ajoutée' }, 'waiting_input'))
    events[CHILD].push(ev(CHILD, 'message.agent', { text: 'ajoute un test', from_task_id: ROOT }))
    events[CHILD].push(ev(CHILD, 'message.agent', { verdict: 'accepted', from_task_id: ROOT }))
    events[ROOT].push(ev(ROOT, 'agent.message', { message: 'C’est fait.' }))

    const thread = buildThread(root, [child], events)
    assert.deepEqual(thread.map((i) => i.kind), ['user', 'delegation', 'proposal', 'reply', 'verdict', 'agent'])
    assert.equal(thread[1]!.to, 'Developer · 00000000')
    assert.equal(thread[2]!.from, 'Developer · 00000000')
    assert.equal(thread[3]!.text, 'ajoute un test')
    assert.ok(!thread.some((i) => i.text === 'relance'), 'une note du harness n’est pas une parole')
  })

  it('n’ouvre la saisie que lorsque la conversation attend l’utilisateur', () => {
    assert.deepEqual(composerState(task(ROOT, { status: 'waiting_input', awaiting_input: 'chat' })), { open: true })
    for (const over of [
      { status: 'running' as const },
      { status: 'waiting_approval' as const },
      { status: 'completed' as const },
      { status: 'waiting_input' as const, awaiting_input: 'chat' as const, mode: 'oneshot' as const },
    ]) {
      const state = composerState(task(ROOT, over))
      assert.equal(state.open, false, JSON.stringify(over))
    }
  })
})

describe('explorateur', () => {
  it('range dossiers d’abord, et ne perd pas une entrée dont le dossier manque', () => {
    const tree = buildFileTree([
      { path: 'b.ts', type: 'file', size: 1, collapsed: false },
      { path: 'src', type: 'dir', size: null, collapsed: false },
      { path: 'src/a.ts', type: 'file', size: 1, collapsed: false },
      // Arbre coupé : `lib` manque, son fichier remonte au plus proche ancêtre.
      { path: 'lib/orphelin.ts', type: 'file', size: 1, collapsed: false },
    ])
    assert.deepEqual(tree.map((n) => n.name), ['src', 'b.ts', 'orphelin.ts'])
    assert.deepEqual(tree[0]!.children.map((n) => n.path), ['src/a.ts'])
  })

  it('reconnaît le langage d’un fichier, et laisse le reste en texte brut', () => {
    assert.equal(languageFor('src/app.tsx'), 'typescript')
    assert.equal(languageFor('README.md'), 'markdown')
    assert.equal(languageFor('Makefile'), null)
  })

  it('retrouve le dernier fichier écrit, même dans des arguments tronqués', () => {
    seq = 0
    const events = [
      ev(CHILD, 'tool.requested', { name: 'write_file', arguments: '{"path":"src/a.ts","content":"x"}' }),
      ev(CHILD, 'tool.requested', { name: 'read_file', arguments: '{"path":"src/lu.ts"}' }),
      // Tronqué à 4000 caractères : pas du JSON entier, le chemin se lit quand même.
      ev(CHILD, 'tool.requested', { name: 'edit_file', arguments: '{"path":"./src/b \\"c\\".ts","old":"aaaa' }),
    ]
    assert.equal(lastWrittenPath(events), 'src/b "c".ts')
    assert.equal(lastWrittenPath([]), null)
  })
})
