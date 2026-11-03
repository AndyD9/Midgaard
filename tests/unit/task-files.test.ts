/**
 * @file Les fichiers d'une tâche, en lecture seule (Slice 6, étape 5), par
 * HTTP comme le dashboard : un vrai daemon, un vrai dépôt, et un Developer qui
 * modifie, crée et supprime des fichiers dans son worktree.
 *
 * Ce qui est prouvé :
 *  - l'arbre montre le travail de l'agent, **sans `.git`**, les dépendances
 *    repliées, les liens montrés et non suivis ;
 *  - un fichier se lit sur le disque **et** au commit de départ : les deux côtés
 *    du diff, un côté vide pour un fichier créé ou supprimé ;
 *  - un binaire et un fichier trop gros ne rendent pas leur contenu ;
 *  - **aucun chemin hostile ne passe** : `..`, absolu, `.git` en toute casse,
 *    et surtout un lien posé dans le worktree, vers l'extérieur ou vers `.git`
 *    — ce dernier reste sous la racine, et n'est arrêté que par la relecture du
 *    chemin réel ;
 *  - aucune méthode d'écriture n'existe sur ces routes.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  daemonJson,
  loadConfig,
  readRuntime,
  type FileContentResponse,
  type FileTreeResponse,
  type RuntimeInfo,
  type Task,
} from '@midgaard/contracts'
import { reconcileAgents, startDaemon, type Daemon } from '@midgaard/daemon'
import { startFakeProvider, type FakeProvider } from '../fake-provider.ts'

let home: string
let repo: string
let daemon: Daemon
let provider: FakeProvider
let rt: RuntimeInfo
let developer: Task
let researcher: Task
let worktree: string

const ORIGINAL = 'export const a = 1\n'
const CHANGED = 'export const a = 2\n'

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'midgaard-files-'))
  repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'midgaard-files-depot-')))
  const git = (...a: string[]) =>
    execFileSync('git', ['-c', 'user.name=u', '-c', 'user.email=u@example.org', '-c', 'commit.gpgsign=false', ...a], {
      cwd: repo,
      stdio: 'ignore',
    })
  git('init', '-q', '-b', 'main')
  mkdirSync(join(repo, 'src'))
  writeFileSync(join(repo, 'README.md'), '# Projet\n')
  writeFileSync(join(repo, 'src', 'a.ts'), ORIGINAL)
  writeFileSync(join(repo, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01]))
  writeFileSync(join(repo, 'gros.txt'), 'x'.repeat(1024 * 1024 + 10))
  git('add', '-A')
  git('commit', '-q', '-m', 'initial')

  provider = await startFakeProvider()
  const config = loadConfig({ MIDGAARD_HOME: home, MIDGAARD_PORT: '0' })
  daemon = (await startDaemon(config, {
    log: () => {},
    env: { MIDGAARD_VAULT: 'file', MIDGAARD_PROVIDER_API_KEY: 'sk-faux-fichiers' },
  }))!
  rt = readRuntime(config.runtimeFile)!
  daemon.store.upsertProvider({
    id: 'faux', name: 'faux', kind: 'openai-compatible', preset: 'custom', baseUrl: provider.url,
    defaultModel: 'faux-1', secretRef: null, webSearch: 'off',
  })
  reconcileAgents(daemon.store)

  provider.scripts.set('[fichiers]', [
    [{ tool: 'write_file', args: { path: 'src/a.ts', content: CHANGED } }],
    [{ tool: 'write_file', args: { path: 'src/nouveau.ts', content: 'export const n = 0\n' } }],
    [{ tool: 'delete_file', args: { path: 'README.md' } }],
    [{ tool: 'submit_result', args: { summary: 'trois fichiers touchés' } }],
  ])
  const created = daemon.tasks.create({
    objective: '[fichiers] modifie, crée, supprime', agentId: 'developer', context: null, projectDir: repo,
    durationS: 20, needsApproval: false,
  })
  assert.ok(!('error' in created), JSON.stringify(created))
  const done = await daemon.tasks.wait(created.task.id, 20_000, 0)
  assert.equal(done?.task.status, 'completed', done?.task.error ?? '')
  developer = done!.task
  worktree = daemon.store.workspaceForTask(developer.id)!.worktree_path
  // Ce que l'agent ne peut pas faire avec ses outils, mais qu'une commande
  // approuvée pourrait : des dépendances installées et des liens.
  mkdirSync(join(worktree, 'node_modules', 'paquet'), { recursive: true })
  writeFileSync(join(worktree, 'node_modules', 'paquet', 'index.js'), '')
  if (process.platform !== 'win32') {
    symlinkSync('/etc', join(worktree, 'dehors'))
    symlinkSync('.git', join(worktree, 'lien-git'))
  }

  provider.scripts.set('[lecteur]', [[{ tool: 'submit_result', args: { summary: 'lu' } }]])
  const read = daemon.tasks.create({
    objective: '[lecteur] lis', agentId: 'researcher', context: null, projectDir: repo,
    durationS: 20, needsApproval: false,
  })
  assert.ok(!('error' in read))
  researcher = (await daemon.tasks.wait(read.task.id, 20_000, 0))!.task
})

after(async () => {
  daemon.close('fin des tests')
  await daemon.stopped
  provider.server.close()
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

/** `GET` sur l'API du daemon. */
function get<T>(path: string) {
  return daemonJson<T & { error?: string; reason?: string }>(rt, path)
}

/** Un fichier d'une tâche, dans une version. */
function content(task: Task, path: string, rev: 'work' | 'base' = 'work') {
  return get<FileContentResponse>(`/api/tasks/${task.id}/files/content?path=${encodeURIComponent(path)}&rev=${rev}`)
}

describe('l\'arbre', () => {
  it('montre le travail de l\'agent, sans .git, dépendances repliées', async () => {
    const r = await get<FileTreeResponse>(`/api/tasks/${developer.id}/files`)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.source, 'worktree')
    const paths = r.body.entries.map((e) => e.path)
    assert.ok(paths.includes('src/a.ts'))
    assert.ok(paths.includes('src/nouveau.ts'), 'le fichier créé')
    assert.ok(!paths.includes('README.md'), 'le fichier supprimé')
    assert.ok(!paths.some((p) => p.split('/').includes('.git')), 'rien de .git — dans un worktree, c\'est un fichier')
    const modules = r.body.entries.find((e) => e.path === 'node_modules')
    assert.equal(modules?.collapsed, true)
    assert.ok(!paths.some((p) => p.startsWith('node_modules/')), 'replié : son contenu n\'est pas listé')
    assert.equal(r.body.entries.find((e) => e.path === 'src/a.ts')?.size, CHANGED.length)
  })

  it('montre un lien sans le suivre', { skip: process.platform === 'win32' && 'liens symboliques réservés aux administrateurs sous Windows' }, async () => {
    const r = await get<FileTreeResponse>(`/api/tasks/${developer.id}/files`)
    assert.equal(r.body.entries.find((e) => e.path === 'dehors')?.type, 'symlink')
    assert.ok(!r.body.entries.some((e) => e.path.startsWith('dehors/')), 'l\'arbre ne sort pas de la racine')
  })

  it('montre le dossier de projet d\'une tâche qui ne fait que lire', async () => {
    const r = await get<FileTreeResponse>(`/api/tasks/${researcher.id}/files`)
    assert.equal(r.body.source, 'project')
    assert.ok(r.body.entries.some((e) => e.path === 'README.md'), 'le dépôt de l\'utilisateur, intact')
  })
})

describe('un fichier, des deux côtés du diff', () => {
  it('rend la version de travail et celle du commit de départ', async () => {
    const work = await content(developer, 'src/a.ts')
    assert.equal(work.status, 200, JSON.stringify(work.body))
    assert.equal(work.body.text, CHANGED)
    const base = await content(developer, 'src/a.ts', 'base')
    assert.equal(base.body.text, ORIGINAL)
  })

  it('rend un côté vide pour un fichier créé ou supprimé, sans erreur', async () => {
    const created = await content(developer, 'src/nouveau.ts', 'base')
    assert.equal(created.status, 200)
    assert.equal(created.body.exists, false)
    const deleted = await content(developer, 'README.md')
    assert.equal(deleted.status, 200)
    assert.equal(deleted.body.exists, false)
    assert.equal((await content(developer, 'README.md', 'base')).body.text, '# Projet\n')
  })

  it('ne rend pas le contenu d\'un binaire ni d\'un fichier trop gros', async () => {
    for (const rev of ['work', 'base'] as const) {
      const binary = await content(developer, 'image.bin', rev)
      assert.equal(binary.body.binary, true, rev)
      assert.equal(binary.body.text, null, rev)
      const big = await content(developer, 'gros.txt', rev)
      assert.equal(big.body.too_large, true, rev)
      assert.equal(big.body.text, null, rev)
      assert.equal(big.body.size, 1024 * 1024 + 10, rev)
    }
  })

  it('refuse le commit de départ d\'une tâche sans worktree', async () => {
    const r = await content(researcher, 'README.md', 'base')
    assert.equal(r.status, 400)
    assert.equal(r.body.error, 'no_base')
  })
})

describe('chemins hostiles', () => {
  for (const path of ['../README.md', 'src/../../README.md', '/etc/hosts', 'C:/Windows/win.ini', '..\\README.md', '.git', '.git/config', '.GIT/config', 'src/.git/x', '']) {
    it(`refuse « ${path} », dans les deux versions`, async () => {
      for (const rev of ['work', 'base'] as const) {
        const r = await content(developer, path, rev)
        assert.equal(r.status, 400, `${rev} : ${JSON.stringify(r.body)}`)
        assert.equal(r.body.error, 'path_refused')
        assert.equal((r.body as FileContentResponse).text, undefined, 'aucun contenu dans un refus')
      }
    })
  }

  const unix = process.platform === 'win32' && 'liens symboliques réservés aux administrateurs sous Windows'

  it('refuse un lien du worktree qui mène dehors, sans dire où', { skip: unix }, async () => {
    const r = await content(developer, 'dehors/hosts')
    assert.equal(r.status, 400)
    assert.equal(r.body.error, 'path_refused')
    assert.doesNotMatch(JSON.stringify(r.body), /\/etc/, 'le message ne révèle pas la cible du lien')
  })

  it('refuse un lien du worktree qui mène sous .git, bien qu\'il reste sous la racine', { skip: unix }, async () => {
    // `lien-git` → `.git`, un fichier qui désigne le dépôt de l'utilisateur.
    const r = await content(developer, 'lien-git')
    assert.equal(r.status, 400, JSON.stringify(r.body))
    assert.equal(r.body.error, 'path_refused')
  })

  it('refuse une version inconnue, et toute méthode d\'écriture', async () => {
    const bad = await get(`/api/tasks/${developer.id}/files/content?path=src/a.ts&rev=HEAD`)
    assert.equal(bad.status, 400)
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const r = await daemonJson<{ error?: string }>(rt, `/api/tasks/${developer.id}/files/content?path=src/a.ts`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'DELETE' ? undefined : '{}',
      })
      assert.equal(r.status, 405, method)
    }
    assert.equal((await content(developer, 'src/a.ts')).body.text, CHANGED, 'rien n\'a changé')
  })
})
