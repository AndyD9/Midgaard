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
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  daemonJson,
  readRuntime,
  type HarnessConfig,
  type Health,
  type RuntimeInfo,
  type TaskEvent,
  type TaskView,
  type ExecAllowResponse,
  type TaskWorkspaceResponse,
  type WorkspacesResponse,
} from '@midgaard/contracts'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { startFakeProvider, type Turn } from './fake-provider.ts'
import { childEnv, nodeArgsFor, scenario, summarize, tempHome, type Outcome } from './helpers.ts'

const outcomes: Outcome[] = []
const daemonArgs = nodeArgsFor('@midgaard/daemon/main')

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
  provider.scripts.set(tag, script)
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

let v1TaskId = ''
let v3TaskId = ''
let v5TaskId = ''

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
  v1TaskId = task.id
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
  v3TaskId = task.id
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
  v5TaskId = task.id
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

await scenario(outcomes, 'V7 le diff se lit par l\'API, et Claude reçoit la branche et la note de merge', async () => {
  const problems: string[] = []
  const withDiff = (await daemonJson<TaskWorkspaceResponse>(rt, `/api/tasks/${v1TaskId}/workspace`)).body
  if (withDiff.diff?.files.length !== 2) problems.push(`diff : ${withDiff.diff?.files.length} fichier(s) — ${withDiff.unavailable}`)
  if (!withDiff.diff?.patch.includes('+export const health')) problems.push('patch sans le fichier créé')
  const without = (await daemonJson<TaskWorkspaceResponse>(rt, `/api/tasks/${v5TaskId}/workspace`)).body
  if (without.workspace !== null || !/pas de worktree/.test(without.unavailable ?? '')) problems.push('tâche sans worktree mal décrite')

  // Ce que Claude lit réellement : un vrai serveur MCP, un vrai client.
  const client = new Client({ name: 'developer', version: '0' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: nodeArgsFor('@midgaard/mcp-server/main'),
      env: { ...getDefaultEnvironment(), ...childEnv(main.home) } as Record<string, string>,
      stderr: 'ignore',
    }),
  )
  try {
    const res = (await client.callTool({ name: 'harness_get_task_result', arguments: { task_id: v1TaskId } })) as {
      content: { text: string }[]
    }
    const body = JSON.parse(res.content[0]!.text) as { result?: { workspace?: { branch: string }; merge_note?: string } }
    const note = body.result?.merge_note ?? ''
    const branch = body.result?.workspace?.branch ?? '(absente)'
    const health = (await daemonJson<Health>(rt, '/api/health')).body
    if (!note.includes('never merges')) problems.push('la note ne dit pas que le harness ne merge pas')
    if (!note.includes(`git merge ${branch}`)) problems.push('la note ne donne pas la commande de merge')
    if (!note.includes('Do not merge unless the user asks')) problems.push('la note n\'interdit pas de merger d\'office')
    // Le lien du dashboard n'est donné que s'il est réellement servi : la
    // règle « ne rien décrire qui n'existe pas » vaut dans les deux sens.
    const linked = note.includes(`#/tasks/${v1TaskId}`)
    if (health.dashboard_available !== linked) {
      problems.push(`dashboard ${health.dashboard_available ? 'servi mais non cité' : 'cité sans être servi'}`)
    }
    return {
      verdict: problems.length ? 'FAIL' : 'PASS',
      detail: problems.length
        ? problems.join(' ; ')
        : `diff par l'API (2 fichiers), note de merge sur ${branch}, lien du dashboard ${linked ? 'donné (servi)' : 'absent (non servi)'}`,
    }
  } finally {
    await client.close()
  }
})

/** Le worktree d'une tâche, tel que `GET /api/workspaces` le liste. */
async function listing(taskId: string) {
  const body = (await daemonJson<WorkspacesResponse>(rt, '/api/workspaces')).body
  return { body, entry: body.workspaces.find((l) => l.workspace.task_id === taskId) }
}

async function removeWs(id: string, force = false) {
  return daemonJson<{ error?: string; reason?: string; outcome?: string }>(rt, `/api/workspaces/${id}/remove`, {
    method: 'POST',
    body: JSON.stringify({ force, by: 'test' }),
  })
}

await scenario(outcomes, 'V8 un retrait ne perd jamais rien sans qu\'on le demande', async () => {
  const problems: string[] = []
  // Un dossier que rien ne référence : il doit être montré, jamais retiré.
  const orphan = join(main.config.worktreesDir, 'depot-orphelin', 'abcd1234')
  mkdirSync(orphan, { recursive: true })

  const v1 = await listing(v1TaskId)
  const v3 = await listing(v3TaskId)
  if (!v1.entry || v1.entry.dirty !== 0 || v1.entry.task_status !== 'completed') problems.push(`V1 mal listé : ${JSON.stringify(v1.entry && { dirty: v1.entry.dirty, s: v1.entry.task_status })}`)
  if (!v3.entry || !(v3.entry.dirty! > 0)) problems.push('V3 devrait être listé avec du travail non commité')
  if (!v1.body.orphans.includes(realpathSync(orphan))) problems.push(`orphelin non signalé : ${v1.body.orphans.join(', ')}`)

  // Tâche en cours : jamais retirée sous l'agent.
  const repo = makeRepo('v8')
  const active = await delegate(rt, '[V8]', repo, [[{ tool: 'exec', args: { command: 'node', args: ['-v'] } }], submit('x')])
  await waitFor(rt, active.id, new Set(['waiting_approval', ...TERMINAL]))
  const activeWs = (await listing(active.id)).entry!
  const refusedActive = await removeWs(activeWs.workspace.id, true)
  if (refusedActive.status !== 409 || refusedActive.body.error !== 'task_active') problems.push(`tâche active retirée : ${refusedActive.status}`)
  await daemonJson(rt, `/api/tasks/${active.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason: 'test' }) })

  // Travail non commité : refusé sans force, retiré avec, la branche reste.
  const w3 = v3.entry!.workspace
  const refusedDirty = await removeWs(w3.id)
  if (refusedDirty.status !== 409 || refusedDirty.body.error !== 'worktree_dirty') problems.push(`worktree sale retiré sans force : ${refusedDirty.status}`)
  if (!existsSync(w3.worktree_path)) problems.push('worktree sale supprimé malgré le refus')
  const forced = await removeWs(w3.id, true)
  if (forced.status !== 200) problems.push(`retrait forcé refusé : ${forced.body.reason}`)
  if (existsSync(w3.worktree_path)) problems.push('worktree forcé toujours présent')
  if (!git(w3.repo_dir, 'branch', '--list', w3.branch).includes(w3.branch)) problems.push('branche supprimée avec le worktree')
  if (!(await events(rt, v3TaskId)).some((e) => e.type === 'workspace.removed')) problems.push('aucun workspace.removed au journal')

  // Propre : retiré sans force.
  const clean = await removeWs(v1.entry!.workspace.id)
  if (clean.status !== 200) problems.push(`worktree propre refusé : ${clean.body.reason}`)
  if (!existsSync(orphan)) problems.push('orphelin supprimé')
  return {
    verdict: problems.length ? 'FAIL' : 'PASS',
    detail: problems.length
      ? problems.join(' ; ')
      : 'actif refusé, sale refusé puis forcé (branche gardée), propre retiré, orphelin montré et laissé',
  }
})

await scenario(outcomes, 'V9 la liste blanche d\'un dépôt dispense de l\'approbation l\'argv exact, et lui seul', async () => {
  const repo = makeRepo('v9')
  const script = "require('fs').writeFileSync('autorise.txt', 'sans approbation')"
  const problems: string[] = []
  const added = await daemonJson<ExecAllowResponse>(rt, '/api/exec-allow', {
    method: 'POST',
    // Un sous-dossier du dépôt : la liste est rangée sous la racine canonique.
    body: JSON.stringify({ project_dir: join(repo, 'src'), argv: ['node', '-e', script], by: 'test' }),
  })
  if (added.status !== 200 || added.body.repo_dir !== repo) problems.push(`ajout : ${added.status} ${added.body.repo_dir}`)
  const notRepo = await daemonJson(rt, '/api/exec-allow', {
    method: 'POST',
    body: JSON.stringify({ project_dir: join(scratch, 'pas-un-depot'), argv: ['make'] }),
  })
  if (notRepo.status !== 400) problems.push(`hors dépôt accepté : ${notRepo.status}`)

  const task = await delegate(rt, '[V9]', repo, [
    [{ tool: 'exec', args: { command: 'node', args: ['-e', script] } }],
    // Le même programme, un argument de plus : la liste ne le couvre plus.
    [{ tool: 'exec', args: { command: 'node', args: ['-e', script, 'en-plus'] } }],
    submit('fait'),
  ])
  const paused = await waitFor(rt, task.id, new Set(['waiting_approval', ...TERMINAL]))
  const requested = (await events(rt, task.id)).filter((e) => e.type === 'approval.requested')
  if (paused.task.status !== 'waiting_approval') problems.push(`l'argv élargi n'a pas demandé d'approbation : ${paused.task.status}`)
  if (requested.length !== 1) problems.push(`${requested.length} demande(s) au lieu d'une`)
  if (!String((paused.approval?.operation_detail as { args?: string[] })?.args?.at(-1)).includes('en-plus')) problems.push('la demande ne porte pas sur l\'argv élargi')
  await daemonJson(rt, `/api/approvals/${paused.approval!.id}/approve`, { method: 'POST', body: JSON.stringify({ by: 'test' }) })
  const done = await waitFor(rt, task.id, TERMINAL)
  const w = done.task.result?.workspace
  if (!w || !git(repo, 'show', `${w.branch}:autorise.txt`).includes('sans approbation')) problems.push('la commande autorisée n\'a pas tourné')
  return {
    verdict: problems.length ? 'FAIL' : 'PASS',
    detail: problems.length ? problems.join(' ; ') : 'argv en liste lancé sans demande, argv élargi soumis à l\'humain, hors dépôt refusé',
  }
})

await scenario(outcomes, 'V10 la CLI liste, retire, et n\'ajoute rien à la liste blanche sans confirmation', async () => {
  const repo = makeRepo('v10')
  const cli = (...args: string[]) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      // Entrée standard fermée : c'est le cas d'un script, ou d'un agent qui
      // lancerait la CLI. Aucun terminal ne peut confirmer.
      const child = spawn(process.execPath, [...nodeArgsFor('@midgaard/cli/main'), ...args], {
        env: childEnv(main.home),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      child.stdout!.on('data', (c) => (out += c))
      child.stderr!.on('data', (c) => (out += c))
      child.on('close', (code) => resolve({ code, out }))
    })
  const problems: string[] = []
  const list = await cli('workspaces')
  const v2 = (await daemonJson<WorkspacesResponse>(rt, '/api/workspaces')).body.workspaces.find((l) => l.workspace.status !== 'removed')
  if (list.code !== 0 || !v2 || !list.out.includes(v2.workspace.branch)) problems.push(`liste : ${list.code}`)
  if (!list.out.includes('depot-orphelin')) problems.push('orphelin absent de la liste')

  const unconfirmed = await cli('exec', 'allow', '--dir', repo, '--', 'node', '-v')
  if (unconfirmed.code === 0) problems.push('ajout accepté sans terminal ni --yes')
  if (!/sans approbation/.test(unconfirmed.out)) problems.push('avertissement absent')
  const after = (await daemonJson<ExecAllowResponse>(rt, `/api/exec-allow?project_dir=${encodeURIComponent(repo)}`)).body
  if (after.entries.length !== 0) problems.push('une entrée a été ajoutée malgré le refus')

  const confirmed = await cli('exec', 'allow', '--yes', '--dir', repo, '--', 'node', '-v')
  const listed = await cli('exec', 'list', '--dir', repo)
  const revoked = await cli('exec', 'revoke', '--dir', repo, '--', 'node', '-v')
  if (confirmed.code !== 0 || !listed.out.includes('node -v') || revoked.code !== 0) problems.push('allow --yes / list / revoke')
  if (v2) {
    const removed = await cli('workspaces', 'remove', v2.workspace.branch)
    if (removed.code !== 0 || !/la branche reste/.test(removed.out)) problems.push(`remove : ${removed.out.trim()}`)
  }

  // `clean` sans --force : les worktrees propres des tâches finies partent, le
  // worktree de V6 — tâche interrompue, fichier en vol non commité — reste.
  const v6 = (await daemonJson<WorkspacesResponse>(rt, '/api/workspaces')).body.workspaces.find(
    (l) => l.workspace.status !== 'removed' && l.dirty !== null && l.dirty > 0,
  )
  const cleaned = await cli('workspaces', 'clean')
  const left = (await daemonJson<WorkspacesResponse>(rt, '/api/workspaces')).body.workspaces.filter(
    (l) => l.workspace.status !== 'removed',
  )
  if (!v6) problems.push('aucun worktree sale pour éprouver clean')
  else if (left.length !== 1 || left[0]!.workspace.id !== v6.workspace.id) {
    problems.push(`clean a laissé ${left.map((l) => l.workspace.branch).join(', ') || 'rien'} au lieu du seul worktree sale`)
  }
  if (v6 && !existsSync(v6.workspace.worktree_path)) problems.push('clean a supprimé le worktree sale')
  if (!/non commité/.test(cleaned.out)) problems.push('clean ne dit pas pourquoi il laisse le worktree sale')
  return {
    verdict: problems.length ? 'FAIL' : 'PASS',
    detail: problems.length
      ? problems.join(' ; ')
      : 'liste, orphelin montré, ajout refusé sans confirmation, --yes/list/revoke, remove, clean laisse le sale',
  }
})

// --- Démontage ---------------------------------------------------------------

await daemonJson(rt, '/api/shutdown', { method: 'POST' }).catch(() => {})
await new Promise((r) => (child.exitCode === null ? child.once('exit', r) : r(null)))
provider.server.close()
main.cleanup()
rmSync(scratch, { recursive: true, force: true })
process.exit(summarize(outcomes, 'Developer de bout en bout'))
