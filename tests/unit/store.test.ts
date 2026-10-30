/**
 * @file Persistance : l'invariant « état et journal indissociables », la
 * numérotation des séquences, l'usage unique des approbations et la
 * réconciliation au redémarrage.
 */
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { DEFAULT_RESEARCHER_LIMITS, IllegalTransitionError, loadConfig } from '@midgaard/contracts'
import { HarnessStore, MIGRATIONS, SCHEMA_VERSION, migrate } from '@midgaard/persistence'

let home: string
let store: HarnessStore

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'midgaard-store-'))
  store = HarnessStore.open(loadConfig({ MIDGAARD_HOME: home }))
})
afterEach(() => {
  store.close()
  rmSync(home, { recursive: true, force: true })
})

/** Tâche de test, prête à avancer. */
function newTask(needsApproval = false) {
  return store.createTask({
    objective: 'objectif',
    agentId: 'simulated',
    context: null,
    projectDir: null,
    limits: DEFAULT_RESEARCHER_LIMITS,
    durationS: 10,
    stepsTotal: 5,
    needsApproval,
  })
}

describe('migrations', () => {
  it('amène une base vierge à la version courante, et est idempotent', () => {
    const version = () =>
      (store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    assert.equal(version(), SCHEMA_VERSION)
    assert.deepEqual(migrate(store.db), [], 'une seconde migration ne doit rien appliquer')
  })

  it('refuse une base venue d\'une version plus récente', () => {
    // Mieux vaut échouer que d'interpréter de travers des colonnes dont le sens
    // a pu changer.
    store.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 10}`)
    assert.throws(() => migrate(store.db), /version de schéma/)
  })
})

describe('droits de la base', { skip: process.platform === 'win32' && 'Windows règle les droits par ACL, pas par mode' }, () => {
  // Ce qui suit l'ouverture du beforeEach : une base neuve, et ses compagnons WAL.
  it('crée la base et ses fichiers WAL lisibles du seul utilisateur', () => {
    newTask() // une écriture, pour que -wal et -shm existent
    for (const suffix of ['', '-wal', '-shm']) {
      const path = `${join(home, 'harness.db')}${suffix}`
      assert.equal(statSync(path).mode & 0o777, 0o600, `${path} en ${(statSync(path).mode & 0o777).toString(8)}`)
    }
  })

  it('resserre une base laissée lisible par une version précédente, et le dit', () => {
    // Constaté sur l'installation de l'auteur : harness.db en 644.
    const dbPath = join(home, 'ancienne.db')
    HarnessStore.open({ dbPath }).close()
    chmodSync(dbPath, 0o644)
    const said: string[] = []
    HarnessStore.open({ dbPath }, (m) => void said.push(m)).close()
    assert.equal(statSync(dbPath).mode & 0o777, 0o600)
    assert.match(said.join('\n'), /droits resserrés de 644 à 600/)
  })
})

describe('migration 7', () => {
  it('donne une liste de sous-modules vide aux worktrees créés avant elle', () => {
    // Une base arrêtée au schéma 6, avec un worktree, comme l'a laissée la Slice 3.
    const old = new DatabaseSync(join(home, 'v6.db'))
    for (const m of MIGRATIONS.filter((m) => m.version <= 6)) old.exec(m.sql)
    old.exec('PRAGMA user_version = 6')
    old.exec(`INSERT INTO tasks (id, objective, status, steps_total, duration_s, created_at, updated_at)
              VALUES ('t', 'o', 'completed', 1, 1, '2026-10-29T00:00:00.000Z', '2026-10-29T00:00:00.000Z')`)
    old.exec(`INSERT INTO workspaces (id, task_id, repo_dir, subdir, worktree_path, branch, base_commit,
                                      base_ref, base_dirty, status, created_at, updated_at)
              VALUES ('w', 't', '/depot', '', '/wt', 'midgaard/t', 'abc', 'main', 0, 'kept',
                      '2026-10-29T00:00:00.000Z', '2026-10-29T00:00:00.000Z')`)
    old.close()
    const migrated = HarnessStore.open({ dbPath: join(home, 'v6.db') })
    try {
      assert.deepEqual(migrated.workspaceForTask('t')?.submodules, [])
    } finally {
      migrated.close()
    }
  })
})

describe('création et journal', () => {
  it('écrit la tâche et son événement ensemble', () => {
    const { task, event } = newTask()
    assert.equal(task.status, 'queued')
    assert.equal(event.type, 'task.created')
    assert.equal(event.task_seq, 1)
    assert.equal(event.status, 'queued')
    assert.equal(store.taskEvents(task.id).length, 1)
  })

  it('numérote task_seq par tâche, et seq globalement', () => {
    const a = newTask().task
    const b = newTask().task
    const e1 = store.record(a.id, 'preparing', { type: 'task.started' })!.event
    const e2 = store.record(b.id, 'preparing', { type: 'task.started' })!.event
    assert.equal(e1.task_seq, 2, 'deuxième événement de la tâche A')
    assert.equal(e2.task_seq, 2, 'deuxième événement de la tâche B')
    assert.ok(e2.seq > e1.seq, 'la séquence globale est strictement croissante')
  })

  it('rend la séquence globale monotone même après suppression de tâches', () => {
    // `AUTOINCREMENT` garantit qu'un numéro libéré n'est jamais réattribué :
    // sans cela, un dashboard ayant vu la séquence 3 manquerait un événement
    // renuméroté 3 après coup.
    const a = newTask().task
    const before = store.lastSeq()
    store.db.exec(`DELETE FROM tasks WHERE id = '${a.id}'`)
    const after = store.record(newTask().task.id, 'preparing', { type: 'task.started' })!.event
    assert.ok(after.seq > before, `${after.seq} devrait dépasser ${before}`)
  })

  it('ne laisse aucun changement d\'état sans événement', () => {
    const { task } = newTask()
    store.record(task.id, 'preparing', { type: 'task.started' })
    store.record(task.id, 'running', { type: 'task.progress' }, { step: 1 })
    store.record(task.id, 'completed', { type: 'task.completed' }, { result: { summary: 'ok', details: '', steps: [], citations: [], untrusted: false, workspace: null } })
    const events = store.taskEvents(task.id)
    assert.deepEqual(
      events.map((e) => e.status),
      ['queued', 'preparing', 'running', 'completed'],
    )
  })

  it('journalise sans changer de statut quand on le demande', () => {
    const { task } = newTask()
    store.record(task.id, 'preparing', { type: 'task.started' })
    const noted = store.record(task.id, null, { type: 'agent.message', payload: { message: 'coucou' } })!
    assert.equal(noted.task.status, 'preparing')
    assert.equal(noted.event.status, 'preparing')
  })
})

describe('transitions', () => {
  it('refuse une transition interdite sans rien écrire', () => {
    const { task } = newTask()
    const before = store.taskEvents(task.id).length
    assert.throws(() => store.record(task.id, 'completed', { type: 'task.completed' }), IllegalTransitionError)
    assert.equal(store.getTask(task.id)!.status, 'queued', 'le statut ne doit pas avoir bougé')
    assert.equal(store.taskEvents(task.id).length, before, 'aucun événement ne doit avoir été écrit')
  })

  it('pose ended_at d\'office à l\'entrée dans un statut final', () => {
    const { task } = newTask()
    store.record(task.id, 'preparing', { type: 'task.started' })
    store.record(task.id, 'running', { type: 'task.progress' })
    const done = store.record(task.id, 'failed', { type: 'task.failed' }, { error: 'boum' })!
    assert.ok(done.task.ended_at, 'ended_at doit être renseigné sans que l\'appelant y pense')
    assert.equal(done.task.error, 'boum')
  })

  it('rend null pour une tâche inconnue plutôt que de lever', () => {
    assert.equal(store.record('00000000-0000-4000-8000-000000000000', 'running', { type: 'task.progress' }), null)
  })
})

describe('redémarrage', () => {
  it('marque interrupted toute tâche restée active, quel que soit son statut', () => {
    const queued = newTask().task
    const running = newTask().task
    store.record(running.id, 'preparing', { type: 'task.started' })
    store.record(running.id, 'running', { type: 'task.progress' })
    const paused = newTask(true).task
    store.record(paused.id, 'preparing', { type: 'task.started' })
    store.record(paused.id, 'running', { type: 'task.progress' })
    store.record(paused.id, 'waiting_approval', { type: 'approval.requested' }, { approval_seq: 1 })
    const finished = newTask().task
    store.record(finished.id, 'preparing', { type: 'task.started' })
    store.record(finished.id, 'running', { type: 'task.progress' })
    store.record(finished.id, 'completed', { type: 'task.completed' }, { result: { summary: 'ok', details: '', steps: [], citations: [], untrusted: false, workspace: null } })

    const interrupted = store.markInterrupted()
    assert.equal(interrupted.length, 3, 'queued, running et waiting_approval doivent tous être interrompus')
    for (const id of [queued.id, running.id, paused.id]) {
      const task = store.getTask(id)!
      assert.equal(task.status, 'interrupted')
      assert.match(task.error!, /redémarrage/)
    }
    assert.equal(store.getTask(finished.id)!.status, 'completed', 'une tâche finie ne bouge pas')
  })

  it('conserve le statut précédent dans l\'événement d\'interruption', () => {
    const { task } = newTask()
    store.record(task.id, 'preparing', { type: 'task.started' })
    store.record(task.id, 'running', { type: 'task.progress' })
    const [recorded] = store.markInterrupted()
    assert.equal(recorded!.event.payload.previous_status, 'running')
  })

  it('n\'a rien à faire sur une base déjà propre', () => {
    assert.deepEqual(store.markInterrupted(), [])
  })
})

describe('approbations', () => {
  function pending() {
    const { task } = newTask(true)
    const approval = store.createApproval({
      taskId: task.id,
      seq: 1,
      operation: 'rm -rf quelque-chose',
      operationDetail: null,
      operationHash: 'abc123',
      ttlMs: 60_000,
    })
    return { task, approval }
  }

  it('ne peut être tranchée qu\'une fois', () => {
    const { approval } = pending()
    assert.equal(store.resolveApproval(approval.id, 'approved', 'cli')!.status, 'approved')
    assert.equal(store.resolveApproval(approval.id, 'rejected', 'dashboard'), null, 'seconde décision refusée')
    assert.equal(store.getApproval(approval.id)!.status, 'approved', 'la première décision tient')
  })

  it('trace qui a décidé, et quand', () => {
    const { approval } = pending()
    const resolved = store.resolveApproval(approval.id, 'rejected', 'dashboard', 'trop risqué')!
    assert.equal(resolved.resolved_by, 'dashboard')
    assert.equal(resolved.reason, 'trop risqué')
    assert.ok(resolved.resolved_at)
  })

  it('n\'expire que ce qui a dépassé son délai', () => {
    const { task } = newTask(true)
    const court = store.createApproval({ taskId: task.id, seq: 1, operation: 'a', operationDetail: null, operationHash: 'h', ttlMs: -1 })
    const long = store.createApproval({ taskId: task.id, seq: 2, operation: 'b', operationDetail: null, operationHash: 'h', ttlMs: 60_000 })
    const due = store.dueApprovals()
    assert.deepEqual(due.map((a) => a.id), [court.id], `${long.id} ne doit pas être dedans`)
  })

  it('ne liste en attente que ce qui l\'est encore', () => {
    const { approval } = pending()
    assert.equal(store.pendingApprovals().length, 1)
    store.resolveApproval(approval.id, 'approved', 'cli')
    assert.deepEqual(store.pendingApprovals(), [])
  })
})

describe('lecture', () => {
  it('compte séparément total et actives', () => {
    const a = newTask().task
    newTask()
    store.record(a.id, 'preparing', { type: 'task.started' })
    store.record(a.id, 'running', { type: 'task.progress' })
    store.record(a.id, 'completed', { type: 'task.completed' }, { result: { summary: 'ok', details: '', steps: [], citations: [], untrusted: false, workspace: null } })
    assert.deepEqual(store.countTasks(), { total: 2, active: 1 })
  })

  it('rejoue les événements après une séquence donnée, dans l\'ordre', () => {
    const { task } = newTask()
    const mark = store.lastSeq()
    store.record(task.id, 'preparing', { type: 'task.started' })
    store.record(task.id, 'running', { type: 'task.progress' })
    const replayed = store.eventsSince(mark, 100)
    assert.deepEqual(replayed.map((e) => e.type), ['task.started', 'task.progress'])
    assert.ok(replayed.every((e) => e.seq > mark))
  })

  it('borne le rejeu à la limite demandée', () => {
    const { task } = newTask()
    for (let i = 0; i < 5; i++) store.record(task.id, null, { type: 'agent.message' })
    assert.equal(store.eventsSince(0, 3).length, 3)
  })
})

describe('espaces de travail', () => {
  /** Un worktree enregistré pour une tâche neuve. */
  function newWorkspace() {
    const { task } = newTask()
    const done = store.createWorkspace({
      taskId: task.id,
      repoDir: '/depot',
      subdir: 'packages/api/',
      worktreePath: `/home/worktrees/depot-1234/${task.id.slice(0, 8)}`,
      branch: `midgaard/${task.id.slice(0, 8)}`,
      baseCommit: 'a'.repeat(40),
      baseRef: 'main',
      baseDirty: 2,
      submodules: ['vendor/lib'],
    })
    assert.ok(done)
    return done
  }

  it('écrit la ligne et son workspace.created dans la même transaction', () => {
    const { workspace, event, task } = newWorkspace()
    assert.equal(workspace.status, 'active')
    assert.equal(workspace.base_dirty, 2)
    assert.deepEqual(workspace.submodules, ['vendor/lib'])
    assert.equal(event.type, 'workspace.created')
    assert.equal(event.payload.workspace_id, workspace.id)
    assert.deepEqual(event.payload.submodules, ['vendor/lib'], 'le journal dit ce qui manque, comme la ligne')
    // Journaliser un worktree ne change pas le statut de la tâche.
    assert.equal(event.status, task.status)
    assert.deepEqual(store.workspaceForTask(task.id), workspace)
  })

  it('refuse un second worktree pour la même tâche, sans écrire d\'événement orphelin', () => {
    const { task } = newWorkspace()
    const before = store.taskEvents(task.id).length
    assert.throws(() =>
      store.createWorkspace({
        taskId: task.id, repoDir: '/depot', subdir: '', worktreePath: '/autre', branch: 'midgaard/autre',
        baseCommit: 'b'.repeat(40), baseRef: null, baseDirty: 0, submodules: [],
      }),
    )
    assert.equal(store.taskEvents(task.id).length, before, 'la transaction annulée n\'a rien laissé')
  })

  it('rend null pour une tâche inconnue', () => {
    assert.equal(
      store.createWorkspace({
        taskId: '00000000-0000-4000-8000-000000000000', repoDir: '/d', subdir: '', worktreePath: '/w',
        branch: 'midgaard/x', baseCommit: 'c'.repeat(40), baseRef: null, baseDirty: 0, submodules: [],
      }),
      null,
    )
  })

  it('n\'admet que active → kept → removed, et ne raconte pas deux fois la même transition', () => {
    const { workspace } = newWorkspace()
    const kept = store.setWorkspaceStatus(workspace.id, 'kept', { reason: 'tâche terminée' })
    assert.equal(kept?.workspace.status, 'kept')
    assert.equal(kept?.event.type, 'workspace.kept')
    assert.equal(store.setWorkspaceStatus(workspace.id, 'kept'), null, 'déjà conservé')

    const removed = store.setWorkspaceStatus(workspace.id, 'removed')
    assert.equal(removed?.workspace.status, 'removed')
    assert.ok(removed?.workspace.removed_at)
    assert.equal(store.setWorkspaceStatus(workspace.id, 'removed'), null, 'déjà retiré')
    assert.equal(store.setWorkspaceStatus(workspace.id, 'kept'), null, 'un worktree retiré ne revient pas')
  })

  it('conserve au redémarrage les worktrees restés actifs, jamais ne les retire', () => {
    const a = newWorkspace().workspace
    const b = newWorkspace().workspace
    store.setWorkspaceStatus(b.id, 'removed')
    const kept = store.keepActiveWorkspaces()
    assert.deepEqual(kept.map((k) => k.workspace.id), [a.id])
    assert.equal(kept[0]!.event.payload.reason, 'daemon redémarré')
    assert.deepEqual(store.listWorkspaces({ status: 'kept' }).map((w) => w.id), [a.id])
    assert.equal(store.listWorkspaces().length, 2)
  })
})

describe('liste blanche exec par dépôt', () => {
  it('range des argv exacts par dépôt, sans doublon, et les retire', () => {
    assert.equal(store.addExecAllow('/depot', ['npm', 'test'], 'cli'), true)
    assert.equal(store.addExecAllow('/depot', ['npm', 'test'], 'cli'), false, 'pas de doublon')
    store.addExecAllow('/depot', ['npm', 'test', '--', '--watch'], 'cli')
    store.addExecAllow('/autre', ['make'], 'cli')

    assert.deepEqual(store.listExecAllow('/depot').map((e) => e.argv), [['npm', 'test'], ['npm', 'test', '--', '--watch']])
    assert.equal(store.listExecAllow('/depot')[0]!.added_by, 'cli')
    assert.equal(store.listExecAllow().length, 3)

    assert.equal(store.removeExecAllow('/depot', ['npm', 'test']), true)
    assert.equal(store.removeExecAllow('/depot', ['npm', 'test']), false)
    assert.deepEqual(store.listExecAllow('/depot').map((e) => e.argv), [['npm', 'test', '--', '--watch']])
  })
})
