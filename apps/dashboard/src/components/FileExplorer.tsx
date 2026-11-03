/**
 * @file L'explorateur de fichiers (Slice 6) : l'arbre d'une tâche, en lecture
 * seule, rechargé à chaque écriture de l'agent.
 *
 * **Suivre l'agent.** Le dernier fichier écrit est marqué d'un point, ses
 * dossiers s'ouvrent, et — tant que « Suivre » est coché — il s'ouvre dans
 * l'éditeur : on voit le fichier que l'agent est en train d'écrire, sans le
 * chercher. Décocher rend la main : rien ne change d'onglet sous vos yeux.
 */
import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, File, Folder, FolderOpen, Link2 } from 'lucide-react'
import type { FileTreeResponse, TaskEvent } from '@midgaard/contracts'
import { fetchFileTree } from '@/lib/api'
import { buildFileTree, filesVersion, lastWrittenPath, type FileNode } from '@/lib/files'
import { cn } from '@/lib/utils'

/** Une source de fichiers proposée : une tâche, et son libellé. */
export interface FileSourceOption {
  taskId: string
  label: string
}

export function FileExplorer({
  options,
  sourceId,
  onSource,
  events,
  activePath,
  onOpen,
  follow,
  onFollow,
}: {
  options: FileSourceOption[]
  sourceId: string | null
  onSource: (taskId: string) => void
  /** Timeline de la tâche source, pour savoir quand recharger et ce qu'elle écrit. */
  events: TaskEvent[] | undefined
  activePath: string | null
  onOpen: (path: string, hasBase: boolean) => void
  follow: boolean
  onFollow: (follow: boolean) => void
}) {
  const [tree, setTree] = useState<FileTreeResponse | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const version = filesVersion(events)
  const written = lastWrittenPath(events)

  useEffect(() => {
    if (!sourceId) return setTree(null)
    let abandoned = false
    fetchFileTree(sourceId)
      .then((body) => {
        if (!abandoned) setTree(body)
      })
      .catch(() => {
        if (!abandoned) setTree(null)
      })
    return () => {
      abandoned = true
    }
  }, [sourceId, version])

  // Les dossiers du fichier en cours d'écriture s'ouvrent, et le fichier aussi
  // quand on suit l'agent.
  useEffect(() => {
    if (!written) return
    setExpanded((current) => {
      const next = new Set(current)
      const parts = written.split('/')
      for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join('/'))
      return next
    })
    if (follow && tree?.source) onOpen(written, tree.source === 'worktree')
    // `onOpen` change d'identité à chaque rendu du parent : seul le chemin écrit compte.
  }, [written, follow, tree?.source])

  const nodes = useMemo(() => buildFileTree(tree?.entries ?? []), [tree])
  const toggle = (path: string) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="explorer">
      <div className="space-y-1.5 border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <h2 className="mr-auto text-xs font-semibold tracking-wide text-muted uppercase">Fichiers</h2>
          <label className="flex items-center gap-1 text-[11px] text-muted" title="Ouvrir le fichier que l'agent écrit">
            <input type="checkbox" checked={follow} onChange={(e) => onFollow(e.target.checked)} data-testid="explorer-follow" />
            Suivre l'agent
          </label>
        </div>
        {options.length > 1 && (
          <select
            className="w-full rounded-md border border-border bg-surface px-2 py-1 text-xs"
            value={sourceId ?? ''}
            onChange={(e) => onSource(e.target.value)}
            data-testid="explorer-source"
          >
            {options.map((o) => (
              <option key={o.taskId} value={o.taskId}>
                {o.label}
              </option>
            ))}
          </select>
        )}
        <p className="text-[11px] text-muted">Lecture seule : seul l'agent écrit.</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1 font-mono text-xs">
        {!sourceId ? (
          <p className="px-3 py-2 text-muted">Sélectionnez une tâche.</p>
        ) : !tree ? (
          <p className="px-3 py-2 text-muted">Chargement…</p>
        ) : tree.unavailable ? (
          <p className="px-3 py-2 text-muted">{tree.unavailable}</p>
        ) : (
          <>
            <Nodes nodes={nodes} depth={0} expanded={expanded} toggle={toggle} written={written} active={activePath}
              open={(p) => onOpen(p, tree.source === 'worktree')} />
            {tree.truncated && <p className="px-3 py-2 text-waiting">Arbre coupé : trop d'entrées.</p>}
          </>
        )}
      </div>
    </div>
  )
}

/** Un niveau de l'arbre. */
function Nodes(props: {
  nodes: FileNode[]
  depth: number
  expanded: Set<string>
  toggle: (path: string) => void
  written: string | null
  active: string | null
  open: (path: string) => void
}) {
  return (
    <ul>
      {props.nodes.map((node) => {
        const pad = { paddingLeft: `${0.75 + props.depth * 0.85}rem` }
        if (node.type === 'dir') {
          const isOpen = props.expanded.has(node.path) && !node.collapsed
          const Icon = isOpen ? FolderOpen : Folder
          return (
            <li key={node.path}>
              <button
                type="button"
                className={cn('flex w-full items-center gap-1 py-0.5 pr-2 text-left hover:bg-accent-soft', node.collapsed && 'text-muted')}
                style={pad}
                onClick={() => !node.collapsed && props.toggle(node.path)}
                title={node.collapsed ? 'Dépendances ou build : non listé' : node.path}
              >
                <ChevronRight className={cn('size-3 shrink-0 transition-transform', isOpen && 'rotate-90', node.collapsed && 'opacity-0')} />
                <Icon className="size-3.5 shrink-0 text-muted" />
                <span className="truncate">{node.name}</span>
              </button>
              {isOpen && <Nodes {...props} nodes={node.children} depth={props.depth + 1} />}
            </li>
          )
        }
        const isWritten = node.path === props.written
        return (
          <li key={node.path}>
            <button
              type="button"
              disabled={node.type === 'symlink'}
              className={cn(
                'flex w-full items-center gap-1 py-0.5 pr-2 text-left hover:bg-accent-soft disabled:cursor-default disabled:text-muted',
                node.path === props.active && 'bg-accent-soft text-accent',
              )}
              style={pad}
              onClick={() => props.open(node.path)}
              title={node.type === 'symlink' ? 'Lien symbolique : non suivi' : node.path}
              data-testid={`explorer-file-${node.path}`}
            >
              <span className="size-3 shrink-0" />
              {node.type === 'symlink' ? <Link2 className="size-3.5 shrink-0" /> : <File className="size-3.5 shrink-0 text-muted" />}
              <span className="truncate">{node.name}</span>
              {isWritten && <span className="ml-auto size-1.5 shrink-0 rounded-full bg-waiting" title="Dernier fichier écrit par l'agent" data-testid="explorer-written" />}
            </button>
          </li>
        )
      })}
    </ul>
  )
}
