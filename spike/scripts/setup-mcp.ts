/**
 * @file Déclare le serveur MCP du harness auprès de Claude Code : `npm run setup`.
 *
 * Écrit (ou complète) le fichier `.mcp.json` à la racine du dépôt, que Claude Code
 * lit à l'ouverture d'une session sur ce dossier. Ce fichier n'est pas versionné :
 * il contient des chemins absolus propres à chaque machine (emplacement du clone,
 * de `node`). Ce script le régénère après un `git clone`.
 *
 * Choix du binaire `node` : le premier trouvé dans le `PATH`, **sans résoudre ses
 * liens symboliques**. Sous Homebrew, `/opt/homebrew/bin/node` est un lien stable
 * qui suit les mises à jour, alors que sa cible (`…/Cellar/node@24/24.18.0/…`)
 * disparaît à la mise à jour suivante. Un chemin absolu plutôt que `node` tout
 * court, car l'app desktop de Claude Code ne lance pas les serveurs MCP avec le
 * même `PATH` que le terminal (constat de la Slice 0 : la commande `claude` y était
 * introuvable).
 *
 * Les autres serveurs déjà déclarés dans `.mcp.json` sont conservés.
 */
import { execFileSync } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { SPIKE_ROOT } from '../src/shared.ts'

/** Version minimale de Node : exécution directe du TypeScript (type stripping). */
const MIN_NODE = [22, 18] as const
/** Nom sous lequel le serveur apparaît dans Claude Code. */
const SERVER_NAME = 'midgaard'

/** Racine du dépôt : le dossier ouvert dans Claude Code, parent de `spike/`. */
const REPO_ROOT = resolve(SPIKE_ROOT, '..')
const MCP_FILE = join(REPO_ROOT, '.mcp.json')
const SERVER_ENTRY = join(SPIKE_ROOT, 'src', 'mcp-server.ts')

/** Indique si la version de ce binaire `node` permet d'exécuter le TypeScript directement. */
function supported(nodePath: string): boolean {
  try {
    const [major, minor] = execFileSync(nodePath, ['-v'], { encoding: 'utf8' }).trim().slice(1).split('.').map(Number)
    return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])
  } catch {
    return false
  }
}

/**
 * Cherche `node` dans le `PATH`, dans l'ordre, sans suivre les liens symboliques.
 * @returns le premier binaire exécutable et assez récent, sinon le `node` qui
 *          exécute ce script (forcément assez récent, puisqu'il lit du TypeScript)
 */
function findNode(): string {
  const exe = process.platform === 'win32' ? 'node.exe' : 'node'
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, exe)
    try {
      accessSync(candidate, constants.X_OK)
    } catch {
      continue
    }
    if (supported(candidate)) return candidate
  }
  return process.execPath
}

/** Lit le `.mcp.json` existant, ou en renvoie un vide. Refuse d'écraser un fichier illisible. */
function readConfig(): { mcpServers: Record<string, unknown>; [key: string]: unknown } {
  if (!existsSync(MCP_FILE)) return { mcpServers: {} }
  try {
    const config = JSON.parse(readFileSync(MCP_FILE, 'utf8'))
    return { ...config, mcpServers: config.mcpServers ?? {} }
  } catch {
    console.error(`${MCP_FILE} existe mais n'est pas du JSON valide : corrige-le ou supprime-le, puis relance.`)
    process.exit(1)
  }
}

const node = findNode()
const config = readConfig()
config.mcpServers[SERVER_NAME] = { type: 'stdio', command: node, args: [SERVER_ENTRY] }
writeFileSync(MCP_FILE, JSON.stringify(config, null, 2) + '\n')

console.log(`Serveur MCP « ${SERVER_NAME} » déclaré dans ${MCP_FILE}`)
console.log(`  node    : ${node}`)
console.log(`  serveur : ${SERVER_ENTRY}`)
console.log('Ouvre une nouvelle session Claude Code sur ce dossier et accepte le serveur quand il est proposé.')
