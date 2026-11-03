/**
 * @file L'explorateur et l'éditeur du dashboard (Slice 6) : l'arbre d'une
 * tâche, le langage d'un fichier, le dernier fichier écrit. Fonctions pures.
 *
 * L'arbre arrive à plat du daemon (`/api/tasks/:id/files`), une entrée par
 * chemin. Il est remis en arborescence ici, dossiers d'abord, comme un
 * explorateur de fichiers.
 */
import type { FileTreeEntry, TaskEvent } from '@midgaard/contracts'

/** Un nœud de l'arbre affiché. */
export interface FileNode {
  name: string
  path: string
  type: FileTreeEntry['type']
  collapsed: boolean
  size: number | null
  children: FileNode[]
}

/** Outils qui écrivent un fichier : ce qu'ils touchent est « en cours d'édition ». */
export const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'delete_file'])

/**
 * Remet en arborescence les entrées à plat. Un chemin dont le dossier parent
 * manque (arbre coupé au plafond) est rattaché au plus proche ancêtre présent,
 * plutôt que perdu.
 */
export function buildFileTree(entries: FileTreeEntry[]): FileNode[] {
  const root: FileNode = { name: '', path: '', type: 'dir', collapsed: false, size: null, children: [] }
  const dirs = new Map<string, FileNode>([['', root]])
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    const slash = entry.path.lastIndexOf('/')
    let parentPath = slash === -1 ? '' : entry.path.slice(0, slash)
    while (!dirs.has(parentPath)) parentPath = parentPath.includes('/') ? parentPath.slice(0, parentPath.lastIndexOf('/')) : ''
    const node: FileNode = {
      name: entry.path.slice(slash + 1),
      path: entry.path,
      type: entry.type,
      collapsed: entry.collapsed,
      size: entry.size,
      children: [],
    }
    dirs.get(parentPath)!.children.push(node)
    if (entry.type === 'dir') dirs.set(entry.path, node)
  }
  const order = (nodes: FileNode[]): FileNode[] => {
    nodes.sort((a, b) => (a.type === 'dir') === (b.type === 'dir') ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1)
    for (const n of nodes) order(n.children)
    return nodes
  }
  return order(root.children)
}

/** Langages connus de l'éditeur. */
export type Language = 'javascript' | 'typescript' | 'json' | 'markdown' | 'css' | 'html' | 'python'

/** Langage d'un fichier d'après son extension ; `null` pour du texte brut. */
export function languageFor(path: string): Language | null {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (['ts', 'tsx', 'mts', 'cts'].includes(ext)) return 'typescript'
  if (['js', 'jsx', 'mjs', 'cjs'].includes(ext)) return 'javascript'
  if (ext === 'json') return 'json'
  if (['md', 'markdown'].includes(ext)) return 'markdown'
  if (ext === 'css') return 'css'
  if (['html', 'htm'].includes(ext)) return 'html'
  if (ext === 'py') return 'python'
  return null
}

/**
 * Chemin du dernier fichier écrit par l'agent, d'après le journal ; `null` s'il
 * n'a rien écrit.
 *
 * Lu dans les arguments de `tool.requested`, journalisés tronqués à 4000
 * caractères : un `write_file` long ne se relit pas en JSON entier. Le chemin
 * est le premier champ écrit par le modèle, presque toujours ; on le cherche
 * donc par motif plutôt que par analyse.
 */
export function lastWrittenPath(events: TaskEvent[] | undefined): string | null {
  for (const e of [...(events ?? [])].reverse()) {
    if (e.type !== 'tool.requested' || !WRITE_TOOLS.has(String(e.payload.name))) continue
    const match = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(String(e.payload.arguments ?? ''))
    if (!match) continue
    try {
      return (JSON.parse(`"${match[1]}"`) as string).replace(/^\.\//, '')
    } catch {
      return match[1]!
    }
  }
  return null
}

/**
 * Nombre d'événements qui peuvent avoir changé les fichiers d'une tâche : la fin
 * d'un outil, le cycle du worktree. C'est la clé de rechargement de
 * l'explorateur et de l'éditeur — recharger à chaque événement lancerait une
 * lecture du disque par mise à jour de consommation.
 */
export function filesVersion(events: TaskEvent[] | undefined): number {
  return (events ?? []).filter((e) => e.type === 'tool.completed' || e.type.startsWith('workspace.')).length
}
