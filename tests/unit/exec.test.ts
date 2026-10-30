/**
 * @file `exec` : ce qui tourne, ce qui ne tourne pas, et ce qui ne survit pas.
 *
 * L'invariant central — aucun processus ne survit à l'appel — est vérifié
 * **directement**, en interrogeant les pid au système, et non par un effet
 * visible depuis l'outil. C'est la règle du dépôt depuis le bug de verrou de la
 * Slice 1 : un invariant de processus se teste en comptant les processus.
 *
 * Les commandes lancées sont `node -e …` : `node` est forcément là, puisque la
 * suite tourne dessus, et le script se lit dans le test.
 */
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { execAllowed, findTool, formatArgv, parseExecAllow, type ToolContext } from '@midgaard/tools'

let home: string
let root: string

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'midgaard-exec-')))
  root = join(home, 'worktree')
  mkdirSync(join(root, 'bin'), { recursive: true })
  mkdirSync(join(home, 'dehors'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return { root, httpPolicy: 'open', allowHosts: [], log: () => {}, writable: true, ...over }
}

const exec = findTool('exec')!

/** Exécute `exec` **sans** passer par la politique : on teste ici l'exécution elle-même. */
async function run(args: Record<string, unknown>, c: ToolContext = ctx()) {
  return exec.run(exec.schema.parse(args) as never, c)
}

/** Un `node -e` dont le script est lisible dans le test. */
function node(script: string, ...rest: string[]) {
  return { command: 'node', args: ['-e', script, ...rest] }
}

/** Vrai si le processus existe encore. `kill(pid, 0)` ne tue rien : il demande. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Attend qu'un processus disparaisse — `SIGKILL` est asynchrone — sans dépasser `ms`. */
async function gone(pid: number, ms = 3000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (!alive(pid)) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return !alive(pid)
}

describe('politique', () => {
  const policy = (args: Record<string, unknown>, c: ToolContext = ctx()) => exec.policy(exec.schema.parse(args) as never, c)

  it('refuse hors worktree, sans demander', () => {
    assert.equal(policy({ command: 'ls' }, ctx({ writable: false })).decision, 'deny')
    assert.equal(policy({ command: 'ls' }, ctx({ writable: undefined })).decision, 'deny')
  })

  it('demande une approbation par défaut, en montrant l\'argv exact', () => {
    const v = policy({ command: 'npm', args: ['test', '--', '--grep', 'a b'], cwd: 'packages/api' })
    assert.equal(v.decision, 'approval')
    assert.equal(v.reason, "exécuter npm test -- --grep 'a b' (dans packages/api)")
  })

  it('n\'autorise d\'office qu\'un argv exactement en liste blanche', () => {
    const allow = parseExecAllow('npm test ; npx tsc --noEmit')
    assert.deepEqual(allow, [['npm', 'test'], ['npx', 'tsc', '--noEmit']])
    assert.equal(policy({ command: 'npm', args: ['test'] }, ctx({ execAllow: allow })).decision, 'allow')
    assert.equal(policy({ command: 'npm', args: ['test', '--watch'] }, ctx({ execAllow: allow })).decision, 'approval')
    assert.equal(policy({ command: 'npm' }, ctx({ execAllow: allow })).decision, 'approval')
    assert.equal(execAllowed(['npx', 'tsc'], allow), false)
  })

  it('affiche différemment un argument contenant ; et trois arguments', () => {
    // Sinon l'humain approuverait l'un en croyant lire l'autre.
    assert.notEqual(formatArgv(['echo', 'a;b']), formatArgv(['echo', 'a', ';', 'b']))
    assert.equal(formatArgv(['echo', "l'été"]), "echo 'l'\\''été'")
  })
})

describe('exécution', () => {
  it('passe les arguments tels quels : aucun shell ne les interprète', async () => {
    const r = await run(node('console.log(JSON.stringify(process.argv.slice(1)))', 'a;b', '$(whoami)', '&& rm -rf /', '*'))
    assert.match(r.content, /\["a;b","\$\(whoami\)","&& rm -rf \/","\*"\]/)
    assert.equal(r.untrusted, true, 'une sortie de commande est encadrée comme du contenu extérieur')
  })

  it('rend un code non nul comme une réponse, pas comme une erreur', async () => {
    const r = await run(node('console.error("2 tests en échec"); process.exit(3)'))
    assert.match(r.content, /exit code 3/)
    assert.match(r.content, /2 tests en échec/)
    assert.match(r.summary, /code 3/)
  })

  it('n\'expose ni les clés du daemon ni GIT_DIR à la commande', async () => {
    const saved = { key: process.env.VENICE_API_KEY, gitDir: process.env.GIT_DIR }
    process.env.VENICE_API_KEY = 'sk-ne-doit-pas-fuir'
    process.env.GIT_DIR = '/ailleurs'
    try {
      const r = await run(node('console.log(JSON.stringify(process.env))'))
      assert.doesNotMatch(r.content, /sk-ne-doit-pas-fuir|VENICE_API_KEY|GIT_DIR/)
      assert.match(r.content, /"CI":"1"/)
    } finally {
      if (saved.key === undefined) delete process.env.VENICE_API_KEY
      else process.env.VENICE_API_KEY = saved.key
      if (saved.gitDir === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = saved.gitDir
    }
  })

  it('lance un script du worktree par son chemin, refuse un chemin hors du worktree', async () => {
    writeFileSync(join(root, 'bin', 'bonjour.sh'), '#!/bin/sh\necho "bonjour $1"\n')
    chmodSync(join(root, 'bin', 'bonjour.sh'), 0o755)
    assert.match((await run({ command: 'bin/bonjour.sh', args: ['monde'] })).content, /bonjour monde/)
    // `/bin/echo` s'écrit `echo` : un chemin absolu désigne le worktree ou rien.
    await assert.rejects(run({ command: '/bin/echo', args: ['x'] }), /escapes/)
    await assert.rejects(run({ command: '../dehors/x.sh' }), /escapes|no such path/)
    await assert.rejects(run({ command: 'node', args: ['-v'], cwd: '..' }), /escapes/)
  })

  it('ignore les entrées relatives du PATH, qui désigneraient le worktree', async () => {
    // Le piège : un PATH qui contient `.`, et un fichier exécutable écrit par
    // l'agent sous un nom de commande. Il ne doit pas être trouvé.
    writeFileSync(join(root, 'piege-midgaard'), '#!/bin/sh\necho piégé\n')
    chmodSync(join(root, 'piege-midgaard'), 0o755)
    const saved = process.env.PATH
    process.env.PATH = `.${delimiter}bin${delimiter}${saved}`
    try {
      await assert.rejects(run({ command: 'piege-midgaard' }), /command not found/)
    } finally {
      process.env.PATH = saved
    }
  })

  it('conserve le début et la fin d\'une sortie démesurée, et dit ce qu\'il retire', async () => {
    const r = await run(node('console.log("DEBUT"); for (let i = 0; i < 20000; i++) console.log("ligne " + i); console.log("FIN")'))
    assert.match(r.content, /DEBUT/)
    assert.match(r.content, /FIN/)
    assert.match(r.content, /\[… \d+ bytes omitted …\]/)
    assert.ok(r.content.length < 60_000)
  })
})

describe('aucun processus ne survit', () => {
  /** Lance un petit-enfant qui dort, et rend son pid sur stdout avant que le parent ne sorte. */
  const SPAWN_SLEEPER =
    'const c = require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });' +
    'c.unref(); console.log("PID=" + c.pid);'

  it('tue le petit-enfant laissé en tâche de fond quand la commande sort normalement', async () => {
    const r = await run(node(SPAWN_SLEEPER))
    const pid = Number(/PID=(\d+)/.exec(r.content)?.[1])
    assert.ok(pid > 0, r.content)
    assert.equal(await gone(pid), true, `le processus ${pid} a survécu à la commande`)
  })

  it('tue la commande et son groupe au délai, et le dit', async () => {
    const started = Date.now()
    const r = await run({ ...node(`${SPAWN_SLEEPER} setTimeout(() => {}, 60000)`), timeout_s: 1 })
    assert.match(r.content, /killed after 1 s \(timeout\)/)
    assert.ok(Date.now() - started < 1000 + 2000 + 1500, 'SIGTERM au délai, SIGKILL au plus tard après la grâce')
    const pid = Number(/PID=(\d+)/.exec(r.content)?.[1])
    assert.equal(await gone(pid), true, `le processus ${pid} a survécu au délai`)
  })

  it('tue tout à l\'annulation de la tâche', async () => {
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 400)
    const r = await run(node(`${SPAWN_SLEEPER} setTimeout(() => {}, 60000)`), ctx({ signal: abort.signal }))
    assert.match(r.content, /cancelled/)
    const pid = Number(/PID=(\d+)/.exec(r.content)?.[1])
    assert.equal(await gone(pid), true)
  })

  it('ne dépasse pas l\'échéance de la tâche, quel que soit le délai demandé', async () => {
    const started = Date.now()
    const r = await run({ ...node('setTimeout(() => {}, 60000)'), timeout_s: 600 }, ctx({ deadline: Date.now() + 800 }))
    assert.match(r.content, /timeout/)
    assert.ok(Date.now() - started < 5000)
    await assert.rejects(run(node('1'), ctx({ deadline: Date.now() - 1 })), /deadline has passed/)
  })
})

describe('programme introuvable', () => {
  it('le dit, au lieu d\'échouer sur une erreur du système', async () => {
    await assert.rejects(run({ command: 'midgaard-commande-inexistante' }), /command not found/)
  })
})
