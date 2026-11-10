/**
 * @file L'outil `windows_run` tel qu'un agent le reçoit (Slice 9, étape 5.3c),
 * sans daemon ni SSH : un faux port joue la VM.
 *
 * Ce qui est éprouvé, et pourquoi :
 *  - **fermé par défaut** : refus sans port, comme le navigateur ou les outils MCP ;
 *  - **une approbation à chaque appel**, même avec une liste blanche `exec` posée ;
 *  - **ce qui part est ce qui a été approuvé** : le détail figé porte la VM et le script ;
 *  - **la VM changée** entre l'approbation et l'exécution fait tout annuler : rien ne tourne ;
 *  - **le délai borné par l'échéance** de la tâche ;
 *  - **la sortie en direct** passe au terminal, et le **résultat est non fiable**.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { z } from 'zod'
import {
  WINDOWS_MAX_SCRIPT_CHARS,
  windowsRunTool,
  type ToolContext,
  type WindowsPort,
  type WindowsRunOutcome,
  type WindowsTarget,
} from '@midgaard/tools'

/** Une VM visée par défaut. */
const VM: WindowsTarget = {
  id: 'vm1',
  address: '192.168.64.5',
  port: 22,
  username: 'analyste',
  fingerprint: 'SHA256:Kvf3tuIDBIe8bJJHNUJx8NAP9Y1Dk3JlHE2haD46qLI',
}

/** Un résultat d'exécution par défaut, que chaque test ajuste. */
function outcome(over: Partial<WindowsRunOutcome> = {}): WindowsRunOutcome {
  return {
    code: 0,
    stdout: 'ok\n',
    stderr: '',
    stdoutBytes: 3,
    stderrBytes: 0,
    timedOut: false,
    cancelled: false,
    durationMs: 12,
    copied: { files: 4, bytes: 1024, skipped: 1 },
    ...over,
  }
}

/** Un faux port qui note ce qu'on lui demande, et rend ce qu'on lui dit. */
function fakePort(over: { result?: WindowsRunOutcome; target?: WindowsTarget | null } = {}): {
  port: WindowsPort
  runs: { script: string; timeoutMs: number }[]
} {
  const runs: { script: string; timeoutMs: number }[] = []
  const target = 'target' in over ? (over.target ?? null) : VM
  const port: WindowsPort = {
    target: () => target,
    run: async (script, options) => {
      runs.push({ script, timeoutMs: options.timeoutMs })
      options.onOutput?.('stdout', Buffer.from('en direct\n'))
      return over.result ?? outcome()
    },
  }
  return { port, runs }
}

/** Un contexte d'outils, VM posée (ou non). */
function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return { root: '/w', httpPolicy: 'approval', allowHosts: [], writable: true, log: () => {}, ...over }
}

describe('windows_run', () => {
  it('refuse sans port, et quand la VM n\'est plus déclarée', () => {
    assert.equal(windowsRunTool.policy({ script: 'x', timeout_s: 60 }, ctx()).decision, 'deny')
    const gone = fakePort({ target: null })
    assert.equal(windowsRunTool.policy({ script: 'x', timeout_s: 60 }, ctx({ windows: gone.port })).decision, 'deny')
  })

  it('demande une approbation à chaque appel, même avec une liste blanche exec', () => {
    const { port } = fakePort()
    // Une liste blanche large ne couvre pas la VM : l'approbation reste.
    const verdict = windowsRunTool.policy({ script: 'Get-Date', timeout_s: 60 }, ctx({ windows: port, execAllow: [] }))
    assert.equal(verdict.decision, 'approval')
    assert.match(verdict.reason, /vm1.*analyste@192\.168\.64\.5:22.*empreinte SHA256:/)
  })

  it('fige la VM et le script dans le détail approuvé', async () => {
    const { port } = fakePort()
    const prepared = await windowsRunTool.prepare!({ script: 'Get-Date', timeout_s: 90 }, ctx({ windows: port }))
    assert.match(prepared.summary, /lancer sur vm1 .*:\nGet-Date$/)
    assert.deepEqual(prepared.detail, {
      tool: 'windows_run',
      vm: 'vm1',
      address: '192.168.64.5',
      port: 22,
      username: 'analyste',
      fingerprint: VM.fingerprint,
      script: 'Get-Date',
      timeout_s: 90,
    })
  })

  it('refuse un script trop long, en disant d\'écrire un .ps1', () => {
    const parsed = windowsRunTool.schema.safeParse({ script: 'x'.repeat(WINDOWS_MAX_SCRIPT_CHARS + 1), timeout_s: 60 })
    assert.equal(parsed.success, false)
    // Le conseil d'écrire un .ps1 est dans la description du champ, lue par le modèle.
    const schema = z.toJSONSchema(windowsRunTool.schema, { target: 'draft-7', io: 'input' }) as unknown as {
      properties: { script: { description: string } }
    }
    assert.match(schema.properties.script.description, /\.ps1 file in your workspace/)
  })

  it('lance le script approuvé, transmet la sortie en direct, et rend un résultat non fiable', async () => {
    const { port, runs } = fakePort({ result: outcome({ code: 0, stdout: 'bonjour\n', stdoutBytes: 8 }) })
    const seen: string[] = []
    const context = ctx({ windows: port, output: (s, c) => seen.push(`${s}:${c}`), deadline: Date.now() + 60_000 })
    const prepared = await windowsRunTool.prepare!({ script: 'Get-Date', timeout_s: 30 }, context)
    const result = await windowsRunTool.run({ script: 'Get-Date', timeout_s: 30 }, context, prepared)
    assert.deepEqual(runs.map((r) => r.script), ['Get-Date'])
    assert.ok(runs[0]!.timeoutMs <= 30_000)
    assert.deepEqual(seen, ['stdout:en direct\n'])
    assert.equal(result.untrusted, true)
    assert.equal(result.exit_code, 0)
    assert.match(result.content, /exit code 0/)
    assert.match(result.content, /workspace copied: 4 file\(s\), 1024 bytes, 1 skipped/)
    assert.match(result.summary, /windows_run vm1 → code 0/)
  })

  it('ne lance rien si la VM a changé entre l\'approbation et l\'exécution', async () => {
    const { port, runs } = fakePort()
    const context = ctx({ windows: port })
    const prepared = await windowsRunTool.prepare!({ script: 'Get-Date', timeout_s: 30 }, context)
    // La VM est redéclarée sous une autre empreinte pendant l'attente de l'humain.
    port.target = () => ({ ...VM, fingerprint: 'SHA256:zzzz3tuIDBIe8bJJHNUJx8NAP9Y1Dk3JlHE2haD46qLI' })
    await assert.rejects(windowsRunTool.run({ script: 'Get-Date', timeout_s: 30 }, context, prepared), /changed since the script was approved/)
    assert.equal(runs.length, 0, 'rien n\'a tourné')

    // VM disparue : refus aussi.
    port.target = () => null
    await assert.rejects(windowsRunTool.run({ script: 'Get-Date', timeout_s: 30 }, context, prepared), /no longer declared/)
    assert.equal(runs.length, 0)
  })

  it('borne le délai par l\'échéance de la tâche', async () => {
    const { port, runs } = fakePort()
    const context = ctx({ windows: port, deadline: Date.now() + 5_000 })
    const prepared = await windowsRunTool.prepare!({ script: 'x', timeout_s: 600 }, context)
    await windowsRunTool.run({ script: 'x', timeout_s: 600 }, context, prepared)
    assert.ok(runs[0]!.timeoutMs <= 5_000, `délai ${runs[0]!.timeoutMs} borné par l'échéance`)

    const late = ctx({ windows: port, deadline: Date.now() - 1 })
    await assert.rejects(windowsRunTool.run({ script: 'x', timeout_s: 60 }, late, prepared), /deadline has passed/)
  })
})
