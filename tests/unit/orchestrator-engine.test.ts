/**
 * @file Le profil `orchestrator` sur le **vrai moteur d'agent** (Slice 5,
 * étape 4) : un daemon démarré dans le processus de test, un faux fournisseur
 * compatible OpenAI, aucun réseau ni dépense.
 *
 * `delegation.test.ts` éprouve le port avec des moteurs pilotables ; ce qui
 * reste à prouver est le câblage, que rien d'autre ne voit :
 *  - le moteur pose le port de délégation pour un orchestrateur — sans lui,
 *    `list_agents` et `delegate_task` seraient refusés ;
 *  - la sous-tâche créée par le modèle est rattachée au parent, sur son dossier ;
 *  - quand l'orchestrateur rend son résultat, la cascade emporte la sous-tâche
 *    qu'il n'a pas attendue : **aucune tâche active en base** ensuite.
 *
 * Le scénario ne peut pas appeler `wait_for_task` : le faux fournisseur est sans
 * état, et l'identifiant de la sous-tâche n'existe pas quand le scénario
 * s'écrit. L'attente est éprouvée dans `delegation.test.ts`, et le sera de bout
 * en bout par `test:orchestrator` (étape 6).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { loadConfig } from '@midgaard/contracts'
import { reconcileAgents, startDaemon, type Daemon } from '@midgaard/daemon'
import { startFakeProvider, type FakeProvider } from '../fake-provider.ts'

let home: string
let project: string
let daemon: Daemon
let provider: FakeProvider

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'midgaard-orch-'))
  project = realpathSync.native(mkdtempSync(join(tmpdir(), 'midgaard-orch-projet-')))
  writeFileSync(join(project, 'README.md'), '# Projet\n')
  provider = await startFakeProvider()
  const config = loadConfig({ MIDGAARD_HOME: home, MIDGAARD_PORT: '0' })
  // La clé passe par l'environnement injecté du daemon, pas par le coffre :
  // ces tests n'ont rien à déposer dans celui de la machine.
  daemon = (await startDaemon(config, {
    log: () => {},
    env: { MIDGAARD_VAULT: 'file', MIDGAARD_PROVIDER_API_KEY: 'sk-faux-orchestrateur' },
  }))!
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
  rmSync(home, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
})

describe('orchestrateur sur le vrai moteur', () => {
  it('reçoit le port, délègue, et ne laisse aucune sous-tâche derrière lui', async () => {
    provider.scripts.set('[orch-1]', [
      [{ tool: 'list_agents', args: {} }],
      [{ tool: 'delegate_task', args: { agent_id: 'researcher', objective: '[enfant-1] cherche', context: 'rien' } }],
      [{ tool: 'submit_result', args: { summary: 'délégué' } }],
    ])
    // L'enfant tourne en même temps sur le même faux fournisseur, et ne finit
    // jamais seul : il ne s'arrête que par la cascade.
    provider.scripts.set('[enfant-1]', [[{ tool: 'list_directory', args: { path: '.' } }], { text: 'je réfléchis' }])

    const created = daemon.tasks.create({
      objective: '[orch-1] orchestre', agentId: 'orchestrator', context: null, projectDir: project,
      durationS: 20, needsApproval: false,
    })
    assert.ok(!('error' in created), JSON.stringify(created))
    const parent = created.task
    const done = await daemon.tasks.wait(parent.id, 20_000, 0)
    assert.equal(done?.task.status, 'completed', done?.task.error ?? '')

    const calls = daemon.store.toolCalls(parent.id)
    const status = (name: string) => calls.find((c) => c.name === name)?.status
    assert.equal(status('list_agents'), 'succeeded', 'le port a été posé')
    assert.equal(status('delegate_task'), 'succeeded')

    const children = daemon.store.childTasks(parent.id)
    assert.equal(children.length, 1)
    assert.equal(children[0]!.agent_id, 'researcher')
    assert.equal(children[0]!.project_dir, project)

    // La cascade est différée d'une micro-tâche, et l'enfant s'arrête à son
    // prochain point de contrôle : on attend sa fin plutôt que de la supposer.
    const child = await daemon.tasks.wait(children[0]!.id, 10_000, 0)
    assert.equal(child?.task.status, 'cancelled', child?.task.error ?? '')
    assert.equal(daemon.store.childTasks(parent.id, { active: true }).length, 0, 'aucune sous-tâche active en base')
  })

  it('dit au modèle qu\'il est un orchestrateur, sans nommer Claude', () => {
    const system = provider.systems.get('[orch-1]') ?? ''
    assert.match(system, /Orchestrator agent/)
    assert.doesNotMatch(system, /claude|anthropic/i)
  })
})
