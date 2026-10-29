/**
 * @file Persistance : l'invariant « état et journal indissociables », la
 * numérotation des séquences, l'usage unique des approbations et la
 * réconciliation au redémarrage.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { DEFAULT_RESEARCHER_LIMITS, IllegalTransitionError, loadConfig } from '@midgaard/contracts'
import { HarnessStore, SCHEMA_VERSION, migrate } from '@midgaard/persistence'

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
    store.record(task.id, 'completed', { type: 'task.completed' }, { result: { summary: 'ok', details: '', steps: [], citations: [], untrusted: false } })
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
    store.record(finished.id, 'completed', { type: 'task.completed' }, { result: { summary: 'ok', details: '', steps: [], citations: [], untrusted: false } })

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
    const court = store.createApproval({ taskId: task.id, seq: 1, operation: 'a', operationHash: 'h', ttlMs: -1 })
    const long = store.createApproval({ taskId: task.id, seq: 2, operation: 'b', operationHash: 'h', ttlMs: 60_000 })
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
    store.record(a.id, 'completed', { type: 'task.completed' }, { result: { summary: 'ok', details: '', steps: [], citations: [], untrusted: false } })
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
