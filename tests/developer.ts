/**
 * @file Le Developer de bout en bout : un vrai daemon, de vrais dépôts Git, un
 * faux fournisseur de modèle.
 *
 * Le fournisseur est un petit serveur compatible OpenAI (`POST /chat/completions`)
 * qui **joue un scénario** : à chaque tour, il rend l'appel d'outil prévu pour
 * cette tâche. Rien d'autre n'est simulé — le daemon, la boucle, les outils,
 * Git, l'approbation et le redémarrage sont les vrais. C'est ce qui permet
 * d'éprouver le chemin complet du Developer sans réseau et sans dépenser un
 * centime ; `test:live` reste le seul à parler à un vrai modèle.
 *
 * Chaque scénario vérifie un effet **sur le disque ou en base**, jamais une
 * simple réponse : le fichier est sur la branche et pas dans le dépôt de
 * l'utilisateur, le marqueur de la commande existe ou n'existe pas, le worktree
 * survit au redémarrage.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  daemonJson,
  readRuntime,
  type HarnessConfig,
  type RuntimeInfo,
  type TaskEvent,
  type TaskView,
} from '@midgaard/contracts'
import { childEnv, nodeArgsFor, scenario, summarize, tempHome, type Outcome } from './helpers.ts'

const outcomes: Outcome[] = []
const daemonArgs = nodeArgsFor('@midgaard/daemon/main')

// --- Faux fournisseur ------------------------------------------------------

/** Un tour du modèle : des appels d'outils, ou du texte seul. */
type Turn = { tool: string; args: Record<string, unknown> }[] | { text: string }

/** Scénarios, par étiquette présente dans l'objectif de la tâche. */
const scripts = new Map<string, Turn[]>()

/**
 * Rend le tour suivant du scénario de la tâche. Le numéro du tour est le
 * nombre de messages d'assistant déjà dans la conversation : le serveur n'a
 * aucun état, et une requête rejouée rend la même réponse.
 */
function fakeCompletion(body: { messages: { role: string; content: string | null }[] }): unknown {
  const user = body.messages.find((m) => m.role === 'user')?.content ?? ''
  const tag = [...scripts.keys()].find((t) => user.includes(t))
  const turn = tag ? scripts.get(tag)![body.messages.filter((m) => m.role === 'assistant').length] : undefined
  const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
  if (!turn || 'text' in turn) {
    return {
      id: 'faux',
      choices: [{ index: 0, message: { role: 'assistant', content: turn && 'text' in turn ? turn.text : 'fin du scénario' }, finish_reason: 'stop' }],
      usage,
    }
  }
  return {
    id: 'faux',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: turn.map((c, i) => ({
            id: `appel-${i}-${Math.random().toString(36).slice(2, 8)}`,
            type: 'function',
            function: { name: c.tool, arguments: JSON.stringify(c.args) },
          })),
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage,
  }
}

async function startFakeProvider(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      if (req.url?.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'faux-1' }] }))
      res.end(JSON.stringify(fakeCompletion(JSON.parse(raw || '{}'))))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const address = server.address()
  return { server, url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1` }
}

// --- Dépôts et daemon --------------------------------------------------------

/** `git` pour préparer et inspecter les dépôts d'essai, sans dépendre de la machine. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Utilisateur', '-c', 'user.email=utilisateur@example.org', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
}

/** Un dépôt d'utilisateur, avec un commit, et éventuellement du travail en cours. */
function makeRepo(name: string, dirty = false): string {
  const repo = join(scratch, name)
  mkdirSync(join(repo, 'src'), { recursive: true })
  git(scratch, 'init', '-q', '-b', 'main', repo)
  writeFileSync(join(repo, 'README.md'), '# Projet\n\nUne API.\n')
  writeFileSync(join(repo, 'src', 'app.ts'), 'export const routes = ["/"]\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'initial')
  if (dirty) writeFileSync(join(repo, 'src', 'en-cours.ts'), 'export {}\n')
  return repo
}

async function startDaemon(config: HarnessConfig, home: string): Promise<{ child: ChildProcess; rt: RuntimeInfo }> {
  const previous = readRuntime(config.runtimeFile)?.pid
  const child = spawn(process.execPath, daemonArgs, { env: childEnv(home), stdio: 'ignore' })
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    await sleep(80)
    const rt = readRuntime(config.runtimeFile)
    if (rt && rt.pid !== previous && (await daemonJson(rt, '/api/health').then((r) => r.status === 200).catch(() => false))) {
      return { child, rt }
    }
  }
  throw new Error("le daemon n'a pas démarré")
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await sleep(100)
  }
  return false
}

/** Délègue au Developer une tâche dont l'objectif porte l'étiquette de son scénario. */
async function delegate(rt: RuntimeInfo, tag: string, projectDir: string, script: Turn[]) {
  scripts.set(tag, script)
  const res = await daemonJson<TaskView & { error?: string }>(rt, '/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      objective: `${tag} ajouter une route /health`,
      agent_id: 'developer',
      project_dir: projectDir,
      context: 'Le routeur est dans src/app.ts.',
    }),
  })
  if (res.status !== 200 && res.status !== 201) throw new Error(`délégation refusée : ${JSON.stringify(res.body)}`)
  return res.body.task
}

async function view(rt: RuntimeInfo, id: string): Promise<TaskView> {
  return (await daemonJson<TaskView>(rt, `/api/tasks/${id}`)).body
}

async function events(rt: RuntimeInfo, id: string): Promise<TaskEvent[]> {
  return (await daemonJson<{ events: TaskEvent[] }>(rt, `/api/tasks/${id}/events`)).body.events
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'budget_exceeded', 'interrupted'])

async function waitFor(rt: RuntimeInfo, id: string, statuses: Set<string>, ms = 20_000): Promise<TaskView> {
  let last = await view(rt, id)
  await until(async () => statuses.has((last = await view(rt, id)).task.status), ms)
  return last
}

const submit = (summary: string) => [{ tool: 'submit_result', args: { summary, details: 'détails' } }]

// ---------------------------------------------------------------------------

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'midgaard-dev-repos-')))
const main = tempHome('developer')
const provider = await startFakeProvider()
let { child, rt } = await startDaemon(main.config, main.home)

const declared = await daemonJson<{ error?: string }>(rt, '/api/providers', {
  method: 'POST',
  body: JSON.stringify({ id: 'faux', preset: 'custom', base_url: provider.url, default_model: 'faux-1', api_key: 'sk-faux-0000' }),
})
if (declared.status !== 200 && declared.status !== 201) {
  console.error('déclaration du faux fournisseur refusée :', declared.body)
  process.exit(1)
}

console.log('Developer de bout en bout (faux fournisseur, vrai daemon, vrais dépôts)\n')

await scenario(outcomes, 'V1 le travail est commité sur la branche, le dépôt de l\'utilisateur intact', async () => {
  const repo = makeRepo('v1')
  const headBefore = git(repo, 'rev-parse', 'HEAD').trim()
  const task = await delegate(rt, '[V1]', repo, [
    [{ tool: 'read_file', args: { path: 'src/app.ts' } }],
    [
      { tool: 'write_file', args: { path: 'src/health.ts', content: 'export const health = () => "ok"\n' } },
      { tool: 'edit_file', args: { path: 'src/app.ts', old_string: '["/"]', new_string: '["/", "/health"]' } },
    ],
    [{ tool: 'git_diff', args: { stat_only: true } }],
    submit('route /health ajoutée'),
  ])
  const done = await waitFor(rt, task.id, TERMINAL)
  const w = done.task.result?.workspace
  const types = (await events(rt, task.id)).map((e) => e.type)
  const problems: string[] = []
  if (done.task.status !== 'completed') problems.push(`statut ${done.task.status} — ${done.task.error}`)
  if (!w?.commit) problems.push('aucun commit dans le résultat')
  if (w && w.files_changed !== 2) problems.push(`${w.files_changed} fichier(s) au lieu de 2`)
  if (w && !w.branch.startsWith('midgaard/')) problems.push(`branche ${w.branch}`)
  if (existsSync(join(repo, 'src', 'health.ts'))) problems.push('fichier écrit dans le dépôt de l\'utilisateur')
  if (git(repo, 'status', '--porcelain') !== '') problems.push('dépôt de l\'utilisateur modifié')
  if (git(repo, 'rev-parse', 'HEAD').trim() !== headBefore) problems.push('HEAD de l\'utilisateur déplacé')
  if (w && !git(repo, 'show', `${w.branch}:src/health.ts`).includes('health')) problems.push('fichier absent de la branche')
  if (w && git(repo, 'log', '-1', '--format=%ae', w.branch).trim() !== 'developer@midgaard.invalid') problems.push('commit à la mauvaise identité')
  if (!types.includes('workspace.created') || !types.includes('workspace.kept')) problems.push(`événements ${types.join(',')}`)
  if (w && !existsSync(w.worktree_path)) problems.push('worktree retiré')
  if (w && !w.worktree_path.startsWith(realpathSync(main.home))) problems.push(`worktree hors de MIDGAARD_HOME : ${w.worktree_path}`)
  return {
    verdict: problems.length ? 'FAIL' : 'PASS',
    detail: problems.length ? problems.join(' ; ') : `${w!.branch} @ ${w!.commit!.slice(0, 8)}, 2 fichiers, dépôt intact, worktree conservé`,
  }
})

await scenario(outcomes, 'V2 une commande attend l\'humain, montrée exacte, puis tourne dans le worktree', async () => {
  const repo = makeRepo('v2')
  const task = await delegate(rt, '[V2]', repo, [
    [{ tool: 'exec', args: { command: 'node', args: ['-e', "require('fs').writeFileSync('marqueur.txt', 'a tourné')"] } }],
    submit('commande lancée'),
  ])
  const paused = await waitFor(rt, task.id, new Set(['waiting_approval', ...TERMINAL]))
  const approval = paused.approval
  const detail = approval?.operation_detail as { program?: string; args?: string[]; cwd?: string } | null | undefined
  const problems: string[] = []
  if (paused.task.status !== 'waiting_approval' || !approval) {
    return { verdict: 'FAIL', detail: `pas de pause : ${paused.task.status} — ${paused.task.error}` }
  }
  if (!detail?.program?.startsWith('/') && !/^[A-Za-z]:/.test(detail?.program ?? '')) problems.push(`programme non résolu : ${detail?.program}`)
  if (!detail?.cwd?.includes(join('worktrees'))) problems.push(`dossier hors worktree : ${detail?.cwd}`)
  if (detail?.args?.[1] !== "require('fs').writeFileSync('marqueur.txt', 'a tourné')") problems.push('argv altéré')
  if (existsSync(join(repo, 'marqueur.txt'))) problems.push('a tourné avant l\'approbation, dans le dépôt')

  await daemonJson(rt, `/api/approvals/${approval.id}/approve`, { method: 'POST', body: JSON.stringify({ by: 'test' }) })
  const done = await waitFor(rt, task.id, TERMINAL)
  const w = done.task.result?.workspace
  if (done.task.status !== 'completed') problems.push(`statut ${done.task.status} — ${done.task.error}`)
  if (w && !git(repo, 'show', `${w.branch}:marqueur.txt`).includes('a tourné')) problems.push('marqueur absent de la branche')
  if (existsSync(join(repo, 'marqueur.txt'))) problems.push('marqueur dans le dépôt de l\'utilisateur')
  return {
    verdict: problems.length ? 'FAIL' : 'PASS',
    detail: problems.length ? problems.join(' ; ') : `approuvée (${detail!.program}), exécutée dans le worktree, commitée`,
  }
})

await scenario(outcomes, 'V3 une tâche qui échoue ne laisse pas une branche qui a l\'air d\'un résultat', async () => {
  const repo = makeRepo('v3')
  const task = await delegate(rt, '[V3]', repo, [
    [{ tool: 'write_file', args: { path: 'src/moitie.ts', content: 'export const a =\n' } }],
    { text: 'je crois avoir fini' },
    { text: 'vraiment fini' },
  ])
  const done = await waitFor(rt, task.id, TERMINAL)
  const ws = (await events(rt, task.id)).find((e) => e.type === 'workspace.created')?.payload as
    | { branch: string; base_commit: string; worktree_path: string }
    | undefined
  const problems: string[] = []
  if (done.task.status !== 'failed') problems.push(`statut ${done.task.status}`)
  if (!ws) return { verdict: 'FAIL', detail: 'aucun worktree créé' }
  if (git(repo, 'rev-parse', ws.branch).trim() !== ws.base_commit) problems.push('la branche a avancé malgré l\'échec')
  if (!existsSync(join(ws.worktree_path, 'src', 'moitie.ts'))) problems.push('travail partiel perdu')
  return {
    verdict: problems.length ? 'FAIL' : 'PASS',
    detail: problems.length ? problems.join(' ; ') : 'échec, branche au commit de départ, travail partiel lisible dans le worktree',
  }
})

await scenario(outcomes, 'V4 le travail non commité de l\'utilisateur est annoncé, pas recopié', async () => {
  const repo = makeRepo('v4', true)
  const task = await delegate(rt, '[V4]', repo, [submit('rien à faire')])
  const done = await waitFor(rt, task.id, TERMINAL)
  const w = done.task.result?.workspace
  const problems: string[] = []
  if (w?.base_dirty !== 1) problems.push(`base_dirty ${w?.base_dirty}`)
  if (w?.commit !== null) problems.push('commit fait alors que rien n\'a changé')
  if (w && existsSync(join(w.worktree_path, 'src', 'en-cours.ts'))) problems.push('travail en cours recopié')
  return {
    verdict: problems.length ? 'FAIL' : 'PASS',
    detail: problems.length ? problems.join(' ; ') : '1 chemin non commité annoncé, absent du worktree, aucun commit vide',
  }
})

await scenario(outcomes, 'V5 un dossier hors dépôt Git échoue en disant pourquoi', async () => {
  const plain = join(scratch, 'pas-un-depot')
  mkdirSync(plain)
  const task = await delegate(rt, '[V5]', plain, [submit('jamais atteint')])
  const done = await waitFor(rt, task.id, TERMINAL)
  const ok = done.task.status === 'failed' && /pas dans un dépôt Git/.test(done.task.error ?? '')
  return { verdict: ok ? 'PASS' : 'FAIL', detail: `${done.task.status} — ${done.task.error}` }
})

await scenario(outcomes, 'V6 un redémarrage interrompt la tâche et conserve son worktree', async () => {
  const repo = makeRepo('v6')
  const task = await delegate(rt, '[V6]', repo, [
    [{ tool: 'write_file', args: { path: 'src/en-vol.ts', content: 'export {}\n' } }],
    [{ tool: 'exec', args: { command: 'node', args: ['-v'] } }],
    submit('jamais atteint'),
  ])
  const paused = await waitFor(rt, task.id, new Set(['waiting_approval', ...TERMINAL]))
  if (paused.task.status !== 'waiting_approval') return { verdict: 'FAIL', detail: `pas de pause : ${paused.task.status}` }
  const created = (await events(rt, task.id)).find((e) => e.type === 'workspace.created')?.payload as { worktree_path: string }

  child.kill('SIGKILL')
  await new Promise((r) => child.once('exit', r))
  ;({ child, rt } = await startDaemon(main.config, main.home))

  const after = await view(rt, task.id)
  const kept = (await events(rt, task.id)).find((e) => e.type === 'workspace.kept')
  const problems: string[] = []
  if (after.task.status !== 'interrupted') problems.push(`statut ${after.task.status}`)
  if (!kept || (kept.payload as { reason?: string }).reason !== 'daemon redémarré') problems.push('worktree non marqué conservé')
  if (!existsSync(join(created.worktree_path, 'src', 'en-vol.ts'))) problems.push('travail en vol perdu')
  return {
    verdict: problems.length ? 'FAIL' : 'PASS',
    detail: problems.length ? problems.join(' ; ') : 'interrupted, workspace.kept « daemon redémarré », fichier en vol présent',
  }
})

// --- Démontage ---------------------------------------------------------------

await daemonJson(rt, '/api/shutdown', { method: 'POST' }).catch(() => {})
await new Promise((r) => (child.exitCode === null ? child.once('exit', r) : r(null)))
provider.server.close()
main.cleanup()
rmSync(scratch, { recursive: true, force: true })
process.exit(summarize(outcomes, 'Developer de bout en bout'))
