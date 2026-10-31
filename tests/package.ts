/**
 * @file Le paquet npm tel qu'un tiers l'installe : `npm run test:package`.
 *
 * `npm run pack:npm` assemble `.pack/midgaard-<version>.tgz` ; cette suite
 * l'installe dans un **préfixe vierge**, avec un **`HOME` vierge** — aucun
 * fournisseur, aucun coffre, aucun `.mcp.json`, aucun daemon —, et ne se sert
 * ensuite que de ce qui a été installé. Rien du dépôt n'est lancé, sauf à K6,
 * où un daemon des sources joue l'« autre installation ».
 *
 *  - K1 l'installation, `harness --version` (la version publiée) et le README
 *       d'installation, pas celui du clone ;
 *  - K2 `harness init` déclare le serveur MCP **installé**, pas celui du dépôt ;
 *  - K3 `harness doctor` sur une installation neuve : sain, dashboard et tarifs
 *       trouvés dans le paquet ;
 *  - K4 un vrai client MCP sur le serveur déclaré : le daemon démarre depuis le
 *       paquet, sert le dashboard, une tâche déléguée aboutit ;
 *  - K5 `harness status` et `harness stop` ;
 *  - K6 cohabitation (décision de l'étape 6) : un daemon d'une autre
 *       installation est remplacé s'il est oisif, et servi tel quel s'il
 *       travaille.
 *
 * Il faut le réseau : npm installe les dépendances externes du paquet depuis
 * le registre, comme chez n'importe qui.
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { daemonJson, readRuntime, pidAlive, type Health } from '@midgaard/contracts'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { nodeArgsFor, scenario, summarize, type Outcome } from './helpers.ts'

const outcomes: Outcome[] = []
const win = process.platform === 'win32'
const root = join(import.meta.dirname, '..')
const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version
const tarball = join(root, '.pack', `midgaard-${version}.tgz`)
if (!existsSync(tarball)) {
  console.error(`${tarball} absent : lance d'abord npm run pack:npm`)
  process.exit(1)
}

// `.native` : le harness canonicalise ainsi, noms courts de Windows développés.
const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'midgaard-tiers-')))
const prefix = join(scratch, 'prefixe')
const home = join(scratch, 'maison')
const project = join(scratch, 'projet')
for (const dir of [prefix, home, project]) mkdirSync(dir)
// npm installe sous `<préfixe>/lib/node_modules` et `<préfixe>/bin` en POSIX,
// directement sous `<préfixe>` sous Windows.
const installed = win ? join(prefix, 'node_modules', 'midgaard') : join(prefix, 'lib', 'node_modules', 'midgaard')
const harnessBin = win ? join(prefix, 'harness.cmd') : join(prefix, 'bin', 'harness')
const runtimeHome = join(home, '.midgaard')

/**
 * Environnement d'un tiers : un `HOME` vierge (et `USERPROFILE`, que lit
 * `os.homedir()` sous Windows), aucun `MIDGAARD_HOME` — le dossier runtime par
 * défaut est éprouvé tel quel. Le coffre est le fichier, pour ne rien déposer
 * dans le trousseau du poste ; le port est libre, pour ne pas croiser un daemon
 * de développement sur 7777.
 */
function thirdPartyEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('MIDGAARD_')) env[k] = v
  return { ...env, HOME: home, USERPROFILE: home, MIDGAARD_VAULT: 'file', MIDGAARD_PORT: '0', NO_COLOR: '1' }
}

/** Lance le `harness` installé. Sous Windows, c'est un `.cmd`, qui exige un shell. */
function harness(...args: string[]) {
  return spawnSync(harnessBin, args, { cwd: project, env: thirdPartyEnv(), encoding: 'utf8', shell: win, timeout: 60_000 })
}

/** Le serveur MCP tel que `.mcp.json` le déclare, avec un vrai client. */
async function connect(): Promise<Client> {
  const entry = (JSON.parse(readFileSync(join(project, '.mcp.json'), 'utf8')) as {
    mcpServers: { midgaard: { command: string; args: string[] } }
  }).mcpServers.midgaard
  const client = new Client({ name: 'tiers', version: '0' })
  await client.connect(
    new StdioClientTransport({
      command: entry.command,
      args: entry.args,
      cwd: project,
      env: { ...getDefaultEnvironment(), ...thirdPartyEnv() },
      stderr: 'ignore',
    }),
  )
  return client
}

/** Le JSON d'une réponse d'outil MCP. */
function payload(res: unknown): Record<string, any> {
  const text = (res as { content: { text: string }[] }).content[0]?.text ?? '{}'
  return JSON.parse(text) as Record<string, any>
}

async function health(): Promise<Health | null> {
  const rt = readRuntime(join(runtimeHome, 'daemon.json'))
  return rt ? daemonJson<Health>(rt, '/api/health').then((r) => r.body).catch(() => null) : null
}

// ---------------------------------------------------------------------------

console.log(`Paquet ${tarball}, installé comme un tiers\n`)

await scenario(outcomes, 'K1 le paquet s\'installe dans un préfixe vierge, et dit sa version', async () => {
  execFileSync('npm', ['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', tarball], {
    stdio: ['ignore', 'ignore', 'inherit'],
    shell: win,
  })
  const r = harness('--version')
  const internal = readdirSync(join(installed, 'node_modules', '@midgaard'))
  const problems: string[] = []
  if (r.stdout.trim() !== version) problems.push(`--version → « ${r.stdout.trim()} » ${r.stderr}`)
  if (internal.length !== 10) problems.push(`${internal.length} paquets internes au lieu de 10`)
  if (existsSync(join(installed, 'node_modules', '@midgaard', 'daemon', 'src'))) problems.push('sources installées')
  // Le README que lira un tiers est celui écrit pour lui, pas celui du clone.
  // Fins de ligne normalisées : sous Windows, le checkout peut être en CRLF.
  const lf = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
  if (lf(join(installed, 'README.md')) !== lf(join(root, 'docs', 'INSTALLER.md'))) problems.push('README.md du paquet ≠ docs/INSTALLER.md')
  return {
    verdict: problems.length ? 'FAIL' : 'PASS',
    detail: problems.length ? problems.join(' ; ') : `harness ${version}, 10 paquets internes, aucune source, README d'installation`,
  }
})

await scenario(outcomes, 'K2 harness init déclare le serveur MCP installé', async () => {
  execFileSync('git', ['init', '-q'], { cwd: project })
  const r = harness('init')
  const declared = JSON.stringify(JSON.parse(readFileSync(join(project, '.mcp.json'), 'utf8')))
  const problems: string[] = []
  if (r.status !== 0) problems.push(`code ${r.status} : ${r.stderr}`)
  if (!declared.includes(JSON.stringify(installed).slice(1, -1))) problems.push(`ne désigne pas le paquet installé : ${declared}`)
  if (declared.includes(JSON.stringify(root).slice(1, -1))) problems.push('désigne le dépôt')
  if (declared.includes('midgaard-dev')) problems.push('condition de développement passée')
  return { verdict: problems.length ? 'FAIL' : 'PASS', detail: problems.length ? problems.join(' ; ') : 'serveur du paquet installé, aucune trace du dépôt' }
})

await scenario(outcomes, 'K3 harness doctor : installation neuve saine, dashboard et tarifs dans le paquet', async () => {
  const r = harness('doctor')
  const problems: string[] = []
  if (r.status !== 0) problems.push(`code ${r.status}`)
  if (!/Dashboard\s+compilé/.test(r.stdout)) problems.push('dashboard non trouvé dans le paquet')
  if (!/Tarifs\s+\d+ modèle/.test(r.stdout)) problems.push('tarifs non trouvés dans le paquet')
  if (!r.stdout.includes(runtimeHome)) problems.push(`dossier runtime inattendu`)
  // Les conseils doivent être des commandes qu'un tiers peut taper.
  if (r.stdout.includes('npm run harness')) problems.push('conseille une commande du dépôt')
  return {
    verdict: problems.length ? 'FAIL' : 'PASS',
    detail: problems.length ? `${problems.join(' ; ')}\n${r.stdout}` : 'sain, dashboard et tarifs trouvés, conseils en « harness … »',
  }
})

await scenario(outcomes, 'K4 Claude délègue par le serveur installé : daemon du paquet, dashboard servi, tâche aboutie', async () => {
  const client = await connect()
  try {
    const ping = payload(await client.callTool({ name: 'harness_ping', arguments: {} }))
    const agents = payload(await client.callTool({ name: 'harness_list_agents', arguments: {} }))
    const h = await health()
    const delegated = payload(
      await client.callTool({ name: 'harness_delegate_task', arguments: { objective: 'essai du paquet', duration_s: 2 } }),
    )
    const done = payload(
      await client.callTool({ name: 'harness_wait_for_task', arguments: { task_id: delegated.task_id, timeout_s: 30 } }),
    )
    const page = h ? await fetch(h.dashboard_url).then(async (r) => ({ status: r.status, html: await r.text() })) : null
    const problems: string[] = []
    if (!ping.protocol) problems.push(`ping : ${JSON.stringify(ping)}`)
    if (!JSON.stringify(agents).includes('simulated')) problems.push('profil simulé absent')
    if (!h?.install.dir.startsWith(installed)) problems.push(`daemon hors du paquet : ${h?.install.dir}`)
    if (h?.install.version !== version) problems.push(`daemon en v${h?.install.version}`)
    if (!h?.dashboard_available || page?.status !== 200 || !/<div id="root"/.test(page.html)) {
      problems.push(`dashboard : ${h?.dashboard_available} ${page?.status}`)
    }
    if (done.status !== 'completed') problems.push(`tâche ${done.status}`)
    return {
      verdict: problems.length ? 'FAIL' : 'PASS',
      detail: problems.length ? problems.join(' ; ') : `daemon v${version} du paquet, dashboard servi, tâche simulée aboutie`,
    }
  } finally {
    await client.close()
  }
})

await scenario(outcomes, 'K5 harness status puis harness stop', async () => {
  const s = harness('status')
  const pid = readRuntime(join(runtimeHome, 'daemon.json'))?.pid
  const stop = harness('stop')
  const deadline = Date.now() + 5_000
  while (pid && pidAlive(pid) && Date.now() < deadline) await sleep(100)
  const problems: string[] = []
  if (s.status !== 0 || !/daemon en marche/.test(s.stdout) || !/essai du paquet|completed/.test(s.stdout)) problems.push(`status : ${s.stdout}`)
  if (stop.status !== 0) problems.push(`stop : code ${stop.status}`)
  if (pid && pidAlive(pid)) problems.push('daemon encore vivant')
  return { verdict: problems.length ? 'FAIL' : 'PASS', detail: problems.length ? problems.join(' ; ') : 'tâche listée, daemon arrêté' }
})

await scenario(outcomes, 'K6 un daemon d\'une autre installation : remplacé s\'il est oisif, servi s\'il travaille', async () => {
  // L'« autre installation » : le daemon des sources du dépôt, sur le même
  // dossier runtime — exactement le clone de développement de l'auteur.
  const startForeign = async () => {
    const child = spawn(process.execPath, nodeArgsFor('@midgaard/daemon/main'), {
      env: { ...thirdPartyEnv(), MIDGAARD_HOME: runtimeHome },
      stdio: 'ignore',
    })
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const h = await health()
      if (h && h.pid === child.pid) return { child, h }
      await sleep(100)
    }
    throw new Error('le daemon des sources n\'a pas démarré')
  }
  /**
   * Attend la fin d'un daemon lancé ici, cinq secondes au plus, puis le tue :
   * un daemon qu'on n'a pas su remplacer ne doit pas bloquer la suite. La
   * première version attendait sans borne, et la contre-épreuve (remplacement
   * désactivé) a bloqué au lieu d'échouer.
   */
  const end = async (child: ChildProcess) => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit')
    if (await Promise.race([exited.then(() => true), sleep(5_000).then(() => false)])) return
    child.kill('SIGKILL')
    await exited
  }
  const problems: string[] = []

  // Oisif : remplacé au premier appel.
  const idle = await startForeign()
  let client = await connect()
  await client.callTool({ name: 'harness_ping', arguments: {} })
  await client.close()
  const after = await health()
  if (!idle.h.install.dir.startsWith(root)) problems.push(`daemon « étranger » mal choisi : ${idle.h.install.dir}`)
  if (after?.pid === idle.child.pid || !after?.install.dir.startsWith(installed)) {
    problems.push(`oisif non remplacé : ${after?.install.dir}`)
  }
  harness('stop')
  await end(idle.child)
  await sleep(500)

  // Au travail : servi tel quel, sa tâche intacte.
  const busy = await startForeign()
  const rt = readRuntime(join(runtimeHome, 'daemon.json'))!
  const long = await daemonJson<{ task: { id: string } }>(rt, '/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ objective: 'tâche longue de l\'autre installation', duration_s: 60 }),
  })
  client = await connect()
  const ping = payload(await client.callTool({ name: 'harness_ping', arguments: {} }))
  await client.close()
  const still = await health()
  const task = await daemonJson<{ task: { status: string } }>(rt, `/api/tasks/${long.body.task.id}`)
  if (still?.pid !== busy.child.pid) problems.push('daemon au travail remplacé')
  if (!ping.protocol) problems.push('le serveur installé ne s\'en est pas servi')
  if (!['running', 'queued', 'preparing'].includes(task.body.task.status)) problems.push(`tâche ${task.body.task.status}`)
  await daemonJson(rt, '/api/shutdown', { method: 'POST' }).catch(() => {})
  await end(busy.child)

  return {
    verdict: problems.length ? 'FAIL' : 'PASS',
    detail: problems.length ? problems.join(' ; ') : 'oisif remplacé par le daemon du paquet ; au travail, servi tel quel et sa tâche intacte',
  }
})

// --- Démontage ---------------------------------------------------------------

harness('stop')
rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
process.exit(summarize(outcomes, 'Paquet npm, installé comme un tiers'))
