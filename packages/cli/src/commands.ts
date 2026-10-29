/**
 * @file Les commandes de la CLI `harness`.
 *
 * Chacune rend un code de sortie : `0` si ce qui était demandé a eu lieu, `1`
 * sinon. C'est ce qui permet de les enchaîner dans un script sans relire leur
 * sortie.
 *
 * Toutes les commandes qui parlent au daemon passent par `ensureDaemon`, qui le
 * démarre s'il dort — sauf `status` et `doctor`, qui doivent pouvoir constater
 * son absence sans la provoquer.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { relative } from 'node:path'
import {
  daemonJson,
  readRuntime,
  pidAlive,
  PROTOCOL_VERSION,
  type Approval,
  type HarnessConfig,
  type Health,
  type Task,
  type TaskView,
} from '@midgaard/contracts'
import { HarnessStore, SCHEMA_VERSION } from '@midgaard/persistence'
import { StaticFiles, defaultDashboardDir } from '@midgaard/daemon'
import { ensureDaemon } from '@midgaard/mcp-server'
import { MIN_NODE, SERVER_NAME, mcpConfigPath, mcpServerEntry, writeMcpConfig } from './mcp-config.ts'
import type { McpServerEntry } from './mcp-config.ts'
import { bold, colorStatus, dim, green, humanDuration, mark, red, yellow } from './ui.ts'

/** Journalisation du démarrage de daemon, discrète : la CLI a sa propre sortie. */
const quiet = () => {}

/** Récupère l'état de santé du daemon s'il tourne, sans le démarrer. */
async function probeHealth(config: HarnessConfig): Promise<Health | null> {
  const rt = readRuntime(config.runtimeFile)
  if (!rt) return null
  try {
    const { status, body } = await daemonJson<Health>(rt, '/api/health', { signal: AbortSignal.timeout(1500) })
    return status === 200 ? body : null
  } catch {
    return null
  }
}

// --- init ------------------------------------------------------------------

/**
 * Déclare le serveur MCP auprès de Claude Code pour un dossier de projet.
 * @param projectDir dossier du projet ; par défaut le dossier courant
 */
export function init(projectDir: string): number {
  const { path, entry } = writeMcpConfig(projectDir)
  console.log(`Serveur MCP « ${bold(SERVER_NAME)} » déclaré dans ${path}`)
  console.log(`  ${dim('node')}    : ${entry.command}`)
  console.log(`  ${dim('serveur')} : ${entry.args[entry.args.length - 1]}`)
  console.log()
  console.log('Ouvre une ' + bold('nouvelle') + ' session Claude Code sur ce dossier et accepte le serveur')
  console.log('quand il est proposé : les déclarations MCP ne sont relues qu\'à l\'ouverture d\'une session.')
  return 0
}

// --- start / stop ----------------------------------------------------------

/** Démarre le daemon s'il ne tourne pas, puis affiche où le joindre. */
export async function start(config: HarnessConfig): Promise<number> {
  const rt = await ensureDaemon(config, quiet)
  const { body } = await daemonJson<Health>(rt, '/api/health')
  console.log(`${green('✔')} daemon en marche (pid ${body.pid}, protocole ${body.protocol})`)
  console.log(`  API       : http://127.0.0.1:${body.port}/api`)
  console.log(
    `  dashboard : ${body.dashboard_available ? body.dashboard_url : dim(body.dashboard_url + '  (non compilé — npm run build)')}`,
  )
  console.log(`  base      : ${body.db_path}`)
  return 0
}

/** Arrête le daemon. Ne le démarre pas pour l'arrêter. */
export async function stop(config: HarnessConfig): Promise<number> {
  const rt = readRuntime(config.runtimeFile)
  if (!rt) {
    console.log('Aucun daemon enregistré : rien à arrêter.')
    return 0
  }
  try {
    await daemonJson(rt, '/api/shutdown', { method: 'POST', signal: AbortSignal.timeout(2000) })
    console.log(`${green('✔')} daemon arrêté (pid ${rt.pid})`)
    return 0
  } catch {
    // Le fichier de découverte survit à un `SIGKILL` : distinguer les deux cas.
    const stale = !pidAlive(rt.pid)
    console.log(stale ? 'Le daemon enregistré est mort ; rien à arrêter.' : red('Daemon injoignable.'))
    return stale ? 0 : 1
  }
}

// --- status ----------------------------------------------------------------

/** Affiche l'état du daemon et les tâches récentes. Lit la base même si le daemon dort. */
export async function status(config: HarnessConfig, limit: number): Promise<number> {
  const health = await probeHealth(config)
  if (health) {
    console.log(
      `${green('●')} daemon en marche — pid ${health.pid}, ${humanDuration(health.uptime_s * 1000)} de service, ` +
        `protocole ${health.protocol}`,
    )
    console.log(`  dashboard : ${health.dashboard_available ? health.dashboard_url : dim('non compilé')}`)
    if (health.idle_shutdown_in_ms !== null) {
      console.log(`  inactivité : arrêt dans ${humanDuration(health.idle_shutdown_in_ms)} si rien ne se passe`)
    }
  } else {
    console.log(`${dim('○')} daemon arrêté — l'historique ci-dessous est lu directement dans la base.`)
  }

  if (!existsSync(config.dbPath)) {
    console.log(dim(`\nAucune base à ${config.dbPath} : aucune tâche n'a encore été déléguée.`))
    return 0
  }

  // Lecture directe : en WAL, elle ne gêne pas le daemon s'il écrit au même moment.
  const store = HarnessStore.open(config)
  try {
    const tasks = store.listTasks({ limit })
    const pending = store.pendingApprovals()
    if (pending.length) {
      console.log(`\n${yellow(bold(`${pending.length} approbation(s) en attente`))}`)
      for (const a of pending) console.log(`  ${a.id}  ${a.operation}`)
      console.log(dim(`  harness approve ${pending[0]!.id}`))
    }
    console.log(`\n${bold('Tâches')} (${tasks.length} sur ${store.countTasks().total})`)
    if (!tasks.length) console.log(dim('  aucune'))
    for (const t of tasks) console.log(`  ${formatTaskLine(t)}`)
    return 0
  } finally {
    store.close()
  }
}

/** Une ligne de tableau par tâche : identifiant court, statut, progression, objectif. */
function formatTaskLine(t: Task): string {
  const id = t.id.slice(0, 8)
  const progress = `${t.step}/${t.steps_total}`
  const when = new Date(t.created_at).toLocaleString()
  return `${dim(id)}  ${colorStatus(t.status.padEnd(16))} ${progress.padEnd(5)} ${dim(when)}  ${t.objective}`
}

// --- approve / reject ------------------------------------------------------

/**
 * Approuve ou refuse une demande.
 *
 * Sans identifiant, n'agit que s'il n'y a **qu'une** demande en attente : en cas
 * d'ambiguïté, c'est à l'humain de choisir, et la commande affiche une ligne
 * complète par demande, prête à copier.
 */
export async function decide(
  config: HarnessConfig,
  decision: 'approve' | 'reject',
  approvalId: string | undefined,
  reason: string | undefined,
): Promise<number> {
  const rt = readRuntime(config.runtimeFile)
  if (!rt || !(await probeHealth(config))) {
    console.error(red('Aucun daemon actif : rien n\'attend d\'approbation pour l\'instant.'))
    return 1
  }

  let id = approvalId
  if (!id) {
    const { body } = await daemonJson<{ approvals: Approval[] }>(rt, '/api/approvals')
    const pending = body.approvals
    if (pending.length === 0) {
      console.error('Aucune demande d\'approbation en attente.')
      return 1
    }
    if (pending.length > 1) {
      console.error('Plusieurs demandes attendent, précise laquelle :')
      for (const a of pending) console.error(`  harness ${decision} ${a.id}   # ${a.operation}`)
      return 1
    }
    id = pending[0]!.id
  }

  const outcome = await daemonJson<TaskView & { error?: string }>(rt, `/api/approvals/${id}/${decision}`, {
    method: 'POST',
    body: JSON.stringify({ by: 'cli', reason }),
  }).catch((e: Error) => ({ status: 0, body: { error: e.message } as TaskView & { error?: string } }))

  if (outcome.status !== 200) {
    console.error(red(`Refusé (${outcome.status || 'injoignable'}) : ${outcome.body.error ?? 'erreur inconnue'}`))
    return 1
  }
  const body = outcome.body
  const verb = decision === 'approve' ? 'Approuvé' : 'Refusé'
  console.log(`${green('✔')} ${verb} — tâche ${body.task.id.slice(0, 8)} : ${colorStatus(body.task.status)}`)
  return 0
}

// --- doctor ----------------------------------------------------------------

/** Un contrôle de `doctor` : son verdict, ce qu'il dit, et quoi faire si ça cloche. */
interface Check {
  level: 'ok' | 'warn' | 'fail'
  label: string
  detail: string
  fix?: string
}

/**
 * Diagnostic de l'installation.
 *
 * Vérifie ce qui, en Slice 0, a réellement cassé : version de Node, dossier
 * runtime et ses permissions, schéma de la base, verrou périmé, version de
 * protocole du daemon en marche, et déclaration MCP du dossier courant.
 *
 * @returns `0` si aucun contrôle n'échoue (les avertissements ne font pas échouer)
 */
export async function doctor(config: HarnessConfig, projectDir: string): Promise<number> {
  const checks: Check[] = []

  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
  const nodeOk = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])
  checks.push({
    level: nodeOk ? 'ok' : 'fail',
    label: 'Node',
    detail: `v${process.versions.node} (minimum v${MIN_NODE[0]}.${MIN_NODE[1]})`,
    ...(nodeOk ? {} : { fix: 'Mets Node à jour : node:sqlite exige Node 24 sans drapeau expérimental.' }),
  })

  // Dossier runtime : il contient le jeton du daemon, il doit rester privé.
  if (existsSync(config.home)) {
    const mode = statSync(config.home).mode & 0o777
    checks.push({
      level: mode === 0o700 ? 'ok' : 'warn',
      label: 'Dossier runtime',
      detail: `${config.home} (mode ${mode.toString(8)})`,
      ...(mode === 0o700 ? {} : { fix: `chmod 700 ${config.home}  # il contient le jeton du daemon` }),
    })
  } else {
    checks.push({ level: 'ok', label: 'Dossier runtime', detail: `${config.home} (sera créé au démarrage)` })
  }

  if (existsSync(config.dbPath)) {
    try {
      const store = HarnessStore.open(config)
      const counts = store.countTasks()
      store.close()
      checks.push({
        level: 'ok',
        label: 'Base',
        detail: `schéma v${SCHEMA_VERSION}, ${counts.total} tâche(s), ${counts.active} active(s)`,
      })
    } catch (e) {
      checks.push({ level: 'fail', label: 'Base', detail: (e as Error).message, fix: 'Mets Midgaard à jour.' })
    }
  } else {
    checks.push({ level: 'ok', label: 'Base', detail: 'pas encore créée' })
  }

  const rt = readRuntime(config.runtimeFile)
  const health = await probeHealth(config)
  if (health) {
    const sameProtocol = health.protocol === PROTOCOL_VERSION
    checks.push({
      level: sameProtocol ? 'ok' : 'warn',
      label: 'Daemon',
      detail: `en marche, pid ${health.pid}, protocole ${health.protocol} (ce code : ${PROTOCOL_VERSION})`,
      ...(sameProtocol
        ? {}
        : { fix: 'Un daemon d\'une autre version tourne ; le prochain appel MCP le remplacera automatiquement.' }),
    })
  } else if (rt) {
    // Fichier de découverte sans daemon derrière : reste d'un arrêt brutal.
    const orphan = pidAlive(rt.pid)
    checks.push({
      level: 'warn',
      label: 'Daemon',
      detail: orphan ? `pid ${rt.pid} vivant mais injoignable` : `fichier de découverte périmé (pid ${rt.pid} mort)`,
      fix: orphan ? `kill ${rt.pid}` : 'Rien à faire : le prochain démarrage le remplacera.',
    })
  } else {
    checks.push({ level: 'ok', label: 'Daemon', detail: 'arrêté' })
  }

  checks.push(checkMcpDeclaration(projectDir))

  // On regarde le disque, et non `health.dashboard_available` : celui-ci n'existe
  // que si le daemon tourne, et `doctor` doit pouvoir répondre daemon arrêté.
  // Annoncer « non compilé » faute d'avoir pu vérifier serait exactement le genre
  // d'affirmation fausse que ce diagnostic est censé attraper.
  const dashboard = new StaticFiles(config.dashboardDir ?? defaultDashboardDir())
  checks.push({
    level: dashboard.available ? 'ok' : 'warn',
    label: 'Dashboard',
    detail: dashboard.available
      ? health?.dashboard_available
        ? `compilé, servi sur ${health.dashboard_url}`
        : 'compilé (servi dès que le daemon démarre)'
      : 'non compilé',
    ...(dashboard.available ? {} : { fix: 'npm run build   # sinon les approbations passent par la CLI' }),
  })

  for (const c of checks) {
    console.log(`${mark[c.level]()} ${bold(c.label.padEnd(18))} ${c.detail}`)
    if (c.fix) console.log(`  ${dim('→ ' + c.fix)}`)
  }
  const failed = checks.filter((c) => c.level === 'fail').length
  console.log()
  console.log(failed ? red(`${failed} contrôle(s) en échec.`) : green('Installation saine.'))
  return failed ? 1 : 0
}

/**
 * Vérifie que ce dossier déclare le serveur MCP, et que la déclaration **pointe
 * encore là où il faut**.
 *
 * Une entrée présente ne suffit pas : après un déplacement du dépôt, un `git
 * clone` ailleurs ou une mise à jour de Node, le `.mcp.json` garde des chemins
 * absolus qui n'existent plus, et Claude Code échoue au démarrage du serveur sans
 * rien dire d'utile. C'est le symptôme le plus courant du guide de dépannage de
 * la Slice 0 ; `doctor` doit le nommer.
 */
function checkMcpDeclaration(projectDir: string): Check {
  const mcpPath = mcpConfigPath(projectDir)
  const shown = relative(process.cwd(), mcpPath) || mcpPath
  if (!existsSync(mcpPath)) {
    return { level: 'warn', label: 'Déclaration MCP', detail: `absente de ${shown}`, fix: 'harness init' }
  }
  let declared: McpServerEntry | undefined
  try {
    const parsed = JSON.parse(readFileSafe(mcpPath)) as { mcpServers?: Record<string, McpServerEntry> }
    declared = parsed.mcpServers?.[SERVER_NAME]
  } catch {
    return {
      level: 'fail',
      label: 'Déclaration MCP',
      detail: `${shown} n'est pas du JSON valide`,
      fix: `Corrige ou supprime ${mcpPath}, puis relance harness init.`,
    }
  }
  if (!declared) {
    return { level: 'warn', label: 'Déclaration MCP', detail: `« ${SERVER_NAME} » absent de ${shown}`, fix: 'harness init' }
  }
  const expected = mcpServerEntry()
  const declaredEntry = declared.args[declared.args.length - 1] ?? ''
  const expectedEntry = expected.args[expected.args.length - 1] ?? ''
  if (!existsSync(declared.command) || !existsSync(declaredEntry)) {
    return {
      level: 'fail',
      label: 'Déclaration MCP',
      detail: `${shown} pointe vers des chemins qui n'existent plus`,
      fix: 'harness init   # régénère les chemins absolus pour cette machine',
    }
  }
  if (declaredEntry !== expectedEntry) {
    return {
      level: 'warn',
      label: 'Déclaration MCP',
      detail: `${shown} pointe vers une autre installation (${declaredEntry})`,
      fix: 'harness init   # pour utiliser celle-ci',
    }
  }
  return { level: 'ok', label: 'Déclaration MCP', detail: shown }
}

/** Lecture tolérante : `doctor` ne doit jamais échouer à cause d'un fichier illisible. */
function readFileSafe(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}
