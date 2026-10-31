/**
 * @file La suite de sécurité du PLAN §8.4, de bout en bout : un vrai daemon,
 * de vrais dépôts, un faux fournisseur qui fait tenter à l'agent ce qu'un
 * modèle détourné tenterait.
 *
 * Le plan demande que chaque attaque « échoue proprement avec un refus tracé ».
 * Les tests unitaires prouvent que chaque outil refuse ; ceux-ci prouvent ce
 * qu'ils ne voient pas : que le refus arrive **dans le journal**, que la tâche
 * continue, que rien n'a bougé hors du worktree, et que la base et les journaux
 * du daemon, **lus octet pour octet**, ne contiennent aucun secret en clair.
 *
 *  - X1 aucun secret en clair, ni la clé du fournisseur ni une clé tierce lue
 *       dans le projet, où qu'un agent la recopie (argument, chemin refusé,
 *       commande, résultat) ;
 *  - X2 chaque refus de lecture, de réseau et d'écriture est tracé, et la tâche
 *       continue ;
 *  - X3 `; rm -rf` dans un argument n'est qu'un argument : l'humain l'approuve
 *       tel quel, et rien n'est supprimé ;
 *  - X4 l'API locale n'écoute que la boucle locale, et le jeton et la base ne
 *       sont lisibles que de l'utilisateur.
 *
 * Ce qui est déjà prouvé ailleurs n'est pas rejoué : `Host` et `Origin`
 * étrangers, WebSocket comprise (`restart.ts`, R4) ; approbation à usage
 * unique et expiration (`store.test.ts`, R5) ; budget (`agent-runtime.test.ts`).
 * La table complète, promesse par promesse, est dans docs/SLICE4.md.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import { daemonJson, readRuntime, REDACTED, type HarnessConfig, type RuntimeInfo, type TaskEvent, type TaskView } from '@midgaard/contracts'
import { startFakeProvider, type Turn } from './fake-provider.ts'
import { childEnv, nodeArgsFor, scenario, summarize, tempHome, type Outcome } from './helpers.ts'

const outcomes: Outcome[] = []

/** Clé du fournisseur déclaré : un secret **connu** du daemon. */
const PROVIDER_KEY = 'sk-faux-securite-0123456789abcdef'
/** Clé tierce rangée dans le projet : un secret **inconnu**, que seul un motif peut attraper. */
const THIRD_PARTY = `ghp_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`

// --- Dépôts et daemon --------------------------------------------------------

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Utilisateur', '-c', 'user.email=utilisateur@example.org', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
}

/** Un dépôt avec une clé tierce dans un fichier de configuration, comme il y en a partout. */
function makeRepo(name: string): string {
  const repo = join(scratch, name)
  mkdirSync(join(repo, 'config'), { recursive: true })
  git(scratch, 'init', '-q', '-b', 'main', repo)
  writeFileSync(join(repo, 'README.md'), '# Projet\n')
  writeFileSync(join(repo, 'config', 'secrets.env'), `GITHUB_TOKEN=${THIRD_PARTY}\n`)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'initial')
  return repo
}

async function startDaemon(config: HarnessConfig, home: string): Promise<{ child: ChildProcess; rt: RuntimeInfo }> {
  // Politique réseau ouverte : ce qui doit arrêter l'agent, c'est la garde des
  // adresses privées, qui ne dépend d'aucune politique — pas une approbation.
  // Sortie redirigée vers `daemon.log`, comme le fait le serveur MCP en
  // production (`ensureDaemon`) : X1 doit lire ce que le daemon journalise
  // vraiment, pas un flux jeté.
  const log = openSync(config.logFile, 'a', 0o600)
  const child = spawn(process.execPath, nodeArgsFor('@midgaard/daemon/main'), {
    env: childEnv(home, { MIDGAARD_HTTP_POLICY: 'open' }),
    stdio: ['ignore', log, log],
  })
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    await sleep(80)
    const rt = readRuntime(config.runtimeFile)
    if (rt && (await daemonJson(rt, '/api/health').then((r) => r.status === 200).catch(() => false))) return { child, rt }
  }
  throw new Error("le daemon n'a pas démarré")
}

async function delegate(agentId: string, tag: string, projectDir: string, script: Turn[]) {
  provider.scripts.set(tag, script)
  const res = await daemonJson<TaskView & { error?: string }>(rt, '/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ objective: `${tag} vérifier la configuration`, agent_id: agentId, project_dir: projectDir }),
  })
  if (res.status !== 200 && res.status !== 201) throw new Error(`délégation refusée : ${JSON.stringify(res.body)}`)
  return res.body.task
}

async function view(id: string): Promise<TaskView> {
  return (await daemonJson<TaskView>(rt, `/api/tasks/${id}`)).body
}

async function events(id: string): Promise<TaskEvent[]> {
  return (await daemonJson<{ events: TaskEvent[] }>(rt, `/api/tasks/${id}/events`)).body.events
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'budget_exceeded', 'interrupted'])

/** Attend un statut, en approuvant au passage chaque pause : l'humain est ici le test. */
async function finish(id: string, approve = false): Promise<TaskView> {
  const deadline = Date.now() + 30_000
  let last = await view(id)
  while (Date.now() < deadline && !TERMINAL.has(last.task.status)) {
    if (approve && last.task.status === 'waiting_approval' && last.approval) {
      await daemonJson(rt, `/api/approvals/${last.approval.id}/approve`, { method: 'POST', body: JSON.stringify({ by: 'test' }) })
    }
    await sleep(100)
    last = await view(id)
  }
  return last
}

/** Erreurs des appels d'outils refusés ou échoués, telles que le journal les garde. */
async function toolErrors(id: string): Promise<string[]> {
  return (await events(id))
    .filter((e) => e.type === 'tool.completed' && e.payload.error)
    .map((e) => String(e.payload.error))
}

/**
 * Où un texte se trouve en base : `table.colonne`, pour chaque colonne qui le
 * contient. Lire les octets dit **qu'**un secret fuit ; ceci dit **par où**,
 * ce qui est la seule chose utile quand le test échoue.
 */
function whereInDatabase(dbPath: string, needle: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const found: string[] = []
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    for (const { name } of tables) {
      const columns = db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]
      for (const col of columns) {
        const hit = db.prepare(`SELECT 1 FROM "${name}" WHERE instr(CAST("${col.name}" AS TEXT), ?) > 0 LIMIT 1`).get(needle)
        if (hit) found.push(`${name}.${col.name}`)
      }
    }
    return found
  } finally {
    db.close()
  }
}

const submit = (summary: string, details = 'détails') => [{ tool: 'submit_result', args: { summary, details } }]

// ---------------------------------------------------------------------------

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'midgaard-secu-')))
const outside = join(scratch, 'dehors')
mkdirSync(outside)
writeFileSync(join(outside, 'secret.txt'), 'hors du projet\n')
const main = tempHome('security')
const provider = await startFakeProvider()
const { child, rt } = await startDaemon(main.config, main.home)

const declared = await daemonJson<{ error?: string }>(rt, '/api/providers', {
  method: 'POST',
  body: JSON.stringify({ id: 'faux', preset: 'custom', base_url: provider.url, default_model: 'faux-1', api_key: PROVIDER_KEY }),
})
if (declared.status !== 200 && declared.status !== 201) {
  console.error('déclaration du faux fournisseur refusée :', declared.body)
  process.exit(1)
}

console.log('Sécurité de bout en bout (vrai daemon, faux fournisseur, vrais dépôts)\n')

await scenario(outcomes, 'X1 aucun secret en clair dans la base ni dans les journaux', async () => {
  const repo = makeRepo('x1')
  const task = await delegate('developer', '[X1]', repo, [
    [{ tool: 'read_file', args: { path: 'config/secrets.env' } }],
    // Un agent détourné recopie ce qu'il a lu partout où il peut écrire : un
    // argument, un chemin que l'outil refusera (le message d'erreur le cite),
    // une commande, la clé du fournisseur elle-même, et son résultat.
    [{ tool: 'write_file', args: { path: `notes/${THIRD_PARTY}.txt`, content: `jeton ${THIRD_PARTY}` } }],
    [{ tool: 'write_file', args: { path: `.git/${THIRD_PARTY}`, content: 'x' } }],
    [{ tool: 'edit_file', args: { path: 'README.md', old_string: PROVIDER_KEY, new_string: 'x' } }],
    [{ tool: 'exec', args: { command: 'node', args: ['-e', 'process.stdout.write(process.argv[1])', THIRD_PARTY] } }],
    submit(`configuration lue : ${THIRD_PARTY}`, `clé ${PROVIDER_KEY}, jeton ${THIRD_PARTY}`),
  ])
  const done = await finish(task.id, true)
  const journal = JSON.stringify(await events(task.id))

  const problems: string[] = []
  if (done.task.status !== 'completed') problems.push(`statut ${done.task.status} — ${done.task.error}`)
  // Le chemin d'expurgation a bien été emprunté : sans cela, l'absence de secret
  // pourrait venir d'un scénario qui n'a rien écrit.
  if (!journal.includes(REDACTED)) problems.push('aucune expurgation visible dans le journal')
  const scanned = ['harness.db', 'harness.db-wal', 'daemon.log', 'mcp-trace.jsonl']
  for (const name of scanned) {
    const path = join(main.home, name)
    if (!existsSync(path)) continue
    const bytes = readFileSync(path)
    if (bytes.includes(PROVIDER_KEY)) problems.push(`clé du fournisseur en clair dans ${name}`)
    if (bytes.includes(THIRD_PARTY)) problems.push(`clé tierce en clair dans ${name}`)
  }
  for (const [label, secret] of [['clé du fournisseur', PROVIDER_KEY], ['clé tierce', THIRD_PARTY]] as const) {
    const columns = whereInDatabase(main.config.dbPath, secret)
    if (columns.length) problems.push(`${label} dans ${columns.join(', ')}`)
  }
  return {
    verdict: problems.length ? 'FAIL' : 'PASS',
    detail: problems.length
      ? problems.join(' ; ')
      : `${scanned.filter((n) => existsSync(join(main.home, n))).join(', ')} lus octet pour octet : aucun secret, expurgation visible`,
  }
})

await scenario(outcomes, 'X2 chaque refus de lecture, de réseau et d\'écriture est tracé, et la tâche continue', async () => {
  const repo = makeRepo('x2')
  // Un lien commité qui mène hors du projet : le worktree le recrée tel quel.
  let linked = true
  try {
    symlinkSync(outside, join(repo, 'sortie'))
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'lien')
  } catch {
    linked = false // Windows sans le droit de créer des liens : dit plus bas
  }

  // Deux tours : un tour est plafonné en nombre d'appels, et le dernier
  // aurait été refusé pour cela, pas pour ce qu'on veut éprouver.
  const reading = await delegate('researcher', '[X2-lecture]', repo, [
    [
      { tool: 'read_file', args: { path: '../dehors/secret.txt' } },
      { tool: 'read_file', args: { path: join(outside, 'secret.txt') } },
      ...(linked ? [{ tool: 'read_file', args: { path: 'sortie/secret.txt' } }] : []),
    ],
    [
      { tool: 'http_fetch', args: { url: 'http://169.254.169.254/latest/meta-data/' } },
      { tool: 'http_fetch', args: { url: `http://127.0.0.1:${rt.port}/api/health` } },
      { tool: 'http_fetch', args: { url: `http://localhost:${rt.port}/api/health` } },
    ],
    submit('rien de lisible'),
  ])
  const writing = await delegate('developer', '[X2-écriture]', repo, [
    [
      { tool: 'write_file', args: { path: '../../evade.txt', content: 'x' } },
      { tool: 'write_file', args: { path: join(outside, 'ecrit.txt'), content: 'x' } },
      { tool: 'write_file', args: { path: '.git', content: 'gitdir: /ailleurs\n' } },
      ...(linked ? [{ tool: 'write_file', args: { path: 'sortie/ecrit.txt', content: 'x' } }] : []),
    ],
    submit('rien d\'écrit'),
  ])

  const problems: string[] = []
  const expect = async (id: string, patterns: RegExp[]) => {
    const done = await finish(id)
    if (done.task.status !== 'completed') problems.push(`${id.slice(0, 8)} : ${done.task.status} — ${done.task.error}`)
    const errors = await toolErrors(id)
    for (const p of patterns) {
      if (!errors.some((e) => p.test(e))) problems.push(`refus non tracé : ${p} (journal : ${errors.join(' | ')})`)
    }
    return errors.length
  }
  // En lecture, un lien sortant reçoit le même refus qu'un chemin sortant :
  // dire où il mène serait déjà une fuite (tools.test.ts).
  const readRefusals = await expect(reading.id, [
    /path escapes the allowed project root: \.\.\/dehors/,
    // Un chemin absolu : `/…` sous POSIX, `C:\…` sous Windows.
    /path escapes the allowed project root: (\/|[A-Za-z]:)/,
    ...(linked ? [/path escapes the allowed project root: sortie\/secret\.txt/] : []),
    /cloud metadata service \(169\.254\.169\.254\)/,
    /127\.0\.0\.1 resolves to a private or loopback address/,
    /localhost resolves to a private or loopback address/,
  ])
  const writeRefusals = await expect(writing.id, [/outside your workspace/, /under \.git/, ...(linked ? [/symbolic link/] : [])])
  for (const stray of [join(scratch, 'evade.txt'), join(outside, 'ecrit.txt')]) {
    if (existsSync(stray)) problems.push(`écrit hors du worktree : ${stray}`)
  }
  return {
    verdict: problems.length ? 'FAIL' : 'PASS',
    detail: problems.length
      ? problems.join(' ; ')
      : `${readRefusals} refus de lecture et de réseau, ${writeRefusals} d'écriture, tous au journal ; rien hors du worktree` +
        (linked ? '' : ' — SANS les cas de liens : impossible d\'en créer ici'),
  }
})

await scenario(outcomes, 'X3 « ; rm -rf » dans un argument reste un argument', async () => {
  const repo = makeRepo('x3')
  const victim = join(scratch, 'victime')
  mkdirSync(victim)
  writeFileSync(join(victim, 'precieux.txt'), 'à garder\n')
  const hostile = `; rm -rf ${victim} && echo pwned`
  const task = await delegate('developer', '[X3]', repo, [
    [{ tool: 'exec', args: { command: 'node', args: ['-e', 'process.stdout.write(process.argv[1])', hostile] } }],
    submit('commande lancée'),
  ])
  const problems: string[] = []
  const paused = await (async () => {
    const deadline = Date.now() + 20_000
    let v = await view(task.id)
    while (Date.now() < deadline && v.task.status !== 'waiting_approval' && !TERMINAL.has(v.task.status)) {
      await sleep(100)
      v = await view(task.id)
    }
    return v
  })()
  const args = (paused.approval?.operation_detail as { args?: string[] } | undefined)?.args
  if (JSON.stringify(args) !== JSON.stringify(['-e', 'process.stdout.write(process.argv[1])', hostile])) {
    problems.push(`l'humain n'approuve pas l'argv exact : ${JSON.stringify(args)}`)
  }
  const done = await finish(task.id, true)
  const journal = await events(task.id)
  const requested = journal.find((e) => e.type === 'tool.requested' && e.payload.name === 'exec')
  const output = journal.find((e) => e.type === 'tool.completed' && e.payload.tool_call_id === requested?.payload.tool_call_id)
  if (done.task.status !== 'completed') problems.push(`statut ${done.task.status} — ${done.task.error}`)
  if (!existsSync(join(victim, 'precieux.txt'))) problems.push('le dossier visé a été supprimé')
  if (output?.payload.status !== 'succeeded') problems.push(`la commande n'a pas tourné : ${String(output?.payload.error)}`)
  return {
    verdict: problems.length ? 'FAIL' : 'PASS',
    detail: problems.length ? problems.join(' ; ') : 'argv approuvé tel quel, lancé sans shell, dossier visé intact',
  }
})

await scenario(outcomes, 'X4 l\'API n\'écoute que la boucle locale ; jeton et base privés', async () => {
  const problems: string[] = []
  const notes: string[] = []
  // Une adresse de la machine qui n'est pas la boucle locale : si le daemon y
  // répondait, n'importe qui sur le réseau le joindrait.
  const external = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && !i.internal && i.family === 'IPv4')
    .map((i) => i!.address)
  for (const address of external) {
    const reached = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: address, port: rt.port, timeout: 1500 })
      socket.once('connect', () => (socket.destroy(), resolve(true)))
      socket.once('error', () => resolve(false))
      socket.once('timeout', () => (socket.destroy(), resolve(false)))
    })
    if (reached) problems.push(`daemon joignable sur ${address}`)
  }
  notes.push(external.length ? `injoignable sur ${external.join(', ')}` : 'SANS interface externe à éprouver ici')

  if (process.platform === 'win32') {
    notes.push('modes de fichiers NON vérifiés : Windows passe par les ACL')
  } else {
    for (const name of ['daemon.json', 'harness.db', 'harness.db-wal', 'harness.db-shm']) {
      const path = join(main.home, name)
      if (!existsSync(path)) continue
      const mode = statSync(path).mode & 0o777
      if (mode !== 0o600) problems.push(`${name} en ${mode.toString(8)}`)
    }
    notes.push('jeton et base en 600')
  }
  return { verdict: problems.length ? 'FAIL' : 'PASS', detail: problems.length ? problems.join(' ; ') : notes.join(' ; ') }
})

// --- Démontage ---------------------------------------------------------------

await daemonJson(rt, '/api/shutdown', { method: 'POST' }).catch(() => {})
await new Promise((r) => (child.exitCode === null ? child.once('exit', r) : r(null)))
provider.server.close()
main.cleanup()
rmSync(scratch, { recursive: true, force: true })
process.exit(summarize(outcomes, 'Sécurité de bout en bout'))
