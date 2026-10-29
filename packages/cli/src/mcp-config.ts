/**
 * @file Déclaration du serveur MCP auprès de Claude Code (`harness init`).
 *
 * Écrit (ou complète) un `.mcp.json` que Claude Code lit à l'ouverture d'une
 * session sur le dossier. Ce fichier n'est pas versionnable : il contient des
 * chemins absolus propres à chaque machine.
 *
 * Deux pièges constatés en Slice 0, que ce module évite :
 *
 *  - **Le CLI `claude` n'est pas toujours installé.** On n'en dépend donc pas :
 *    `harness init` écrit la configuration lui-même plutôt que d'appeler
 *    `claude mcp add`.
 *  - **Le chemin de `node` doit être un lien stable.** Sous Homebrew,
 *    `/opt/homebrew/bin/node` suit les mises à jour, alors que sa cible
 *    (`…/Cellar/node@24/24.18.0/…`) disparaît à la version suivante. On cherche
 *    donc dans le `PATH` sans résoudre les liens symboliques. Et un chemin absolu
 *    plutôt que `node` tout court, car l'app desktop de Claude Code ne lance pas
 *    les serveurs MCP avec le même `PATH` qu'un terminal.
 */
import { execFileSync } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Nom sous lequel le serveur apparaît dans Claude Code. */
export const SERVER_NAME = 'midgaard'

/** Version minimale de Node : `node:sqlite` sans drapeau expérimental. */
export const MIN_NODE = [24, 0] as const

/** Déclaration d'un serveur MCP en stdio, telle que Claude Code l'attend. */
export interface McpServerEntry {
  type: 'stdio'
  command: string
  args: string[]
}

/** Indique si ce binaire `node` est assez récent. */
function supported(nodePath: string): boolean {
  try {
    const parts = execFileSync(nodePath, ['-v'], { encoding: 'utf8' }).trim().slice(1).split('.').map(Number)
    const major = parts[0] ?? 0
    const minor = parts[1] ?? 0
    return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])
  } catch {
    return false
  }
}

/**
 * Cherche `node` dans le `PATH`, dans l'ordre, **sans suivre les liens symboliques**.
 * @returns le premier binaire exécutable et assez récent, sinon celui qui exécute
 *          ce script — forcément assez récent, puisqu'il nous fait tourner
 */
export function findNode(): string {
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

/**
 * Compose la déclaration du serveur MCP pour cette installation.
 *
 * `import.meta.resolve` suit les conditions d'export du processus : en
 * développement il rend le `.ts` des sources, une fois compilé le `.js` de
 * `dist/`. Dans le premier cas, le processus lancé par Claude Code doit recevoir
 * la condition explicitement, sinon il résoudrait ses imports vers `dist/`.
 */
export function mcpServerEntry(): McpServerEntry {
  const entry = fileURLToPath(import.meta.resolve('@midgaard/mcp-server/main'))
  const dev = entry.endsWith('.ts')
  return {
    type: 'stdio',
    command: findNode(),
    args: dev ? ['--conditions=midgaard-dev', entry] : [entry],
  }
}

/** Fichier `.mcp.json` d'un dossier de projet. */
export function mcpConfigPath(projectDir: string): string {
  return join(resolve(projectDir), '.mcp.json')
}

/**
 * Ajoute (ou met à jour) l'entrée `midgaard` dans un `.mcp.json`, en conservant
 * les autres serveurs déjà déclarés.
 *
 * @returns le chemin écrit et l'entrée posée
 * @throws si le fichier existe mais n'est pas du JSON valide — on refuse d'écraser
 *         un fichier qu'on ne comprend pas, il contient peut-être d'autres serveurs
 */
export function writeMcpConfig(projectDir: string): { path: string; entry: McpServerEntry } {
  const path = mcpConfigPath(projectDir)
  let config: { mcpServers: Record<string, unknown>; [k: string]: unknown } = { mcpServers: {} }
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      config = { ...parsed, mcpServers: (parsed.mcpServers as Record<string, unknown>) ?? {} }
    } catch {
      throw new Error(`${path} existe mais n'est pas du JSON valide : corrige-le ou supprime-le, puis relance.`)
    }
  }
  const entry = mcpServerEntry()
  config.mcpServers[SERVER_NAME] = entry
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n')
  return { path, entry }
}
