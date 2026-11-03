/**
 * @file Un fichier ouvert dans l'éditeur (Slice 6) : sa version de travail, ou
 * son diff contre le commit de départ, rechargés à chaque écriture de l'agent.
 *
 * Ce qui ne s'affiche pas est **dit** : un binaire, un fichier trop gros, un
 * fichier supprimé par l'agent. Un éditeur vide ne dirait pas laquelle des
 * trois raisons le vide.
 */
import { useEffect, useState } from 'react'
import type { FileContentResponse, TaskEvent } from '@midgaard/contracts'
import { fetchFileContent } from '@/lib/api'
import { filesVersion, languageFor } from '@/lib/files'
import { cn } from '@/lib/utils'
import { CodeView } from './CodeView'

export function FileView({
  taskId,
  path,
  hasBase,
  events,
}: {
  taskId: string
  path: string
  /** Vrai pour un worktree : le diff contre le commit de départ a un sens. */
  hasBase: boolean
  /** Timeline de la tâche, pour recharger à chaque écriture. */
  events: TaskEvent[] | undefined
}) {
  const [work, setWork] = useState<FileContentResponse | null>(null)
  const [base, setBase] = useState<FileContentResponse | null>(null)
  const [mode, setMode] = useState<'file' | 'diff'>(hasBase ? 'diff' : 'file')
  const [error, setError] = useState<string | null>(null)
  const version = filesVersion(events)

  useEffect(() => {
    let abandoned = false
    Promise.all([fetchFileContent(taskId, path, 'work'), hasBase ? fetchFileContent(taskId, path, 'base') : null])
      .then(([w, b]) => {
        if (abandoned) return
        setWork(w)
        setBase(b)
        setError(null)
      })
      .catch((e: unknown) => {
        if (!abandoned) setError((e as Error).message)
      })
    return () => {
      abandoned = true
    }
  }, [taskId, path, hasBase, version])

  if (error) return <p className="p-4 text-sm text-danger">{error}</p>
  if (!work) return <p className="p-4 text-sm text-muted">Chargement…</p>

  const unreadable = [work, base].find((v) => v?.binary || v?.too_large)
  const note = unreadable?.binary
    ? 'Fichier binaire : son contenu n\'est pas affiché.'
    : unreadable?.too_large
      ? `Fichier de ${unreadable.size} octets : au-delà de 1 Mo, son contenu n'est pas affiché.`
      : !work.exists
        ? 'Supprimé par l\'agent : seule la version de départ existe.'
        : hasBase && base && !base.exists
          ? 'Créé par l\'agent : absent du commit de départ.'
          : null

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="file-view" data-path={path}>
      <div className="flex items-center gap-2 border-b border-border px-3 py-1 text-xs">
        <span className="mr-auto truncate font-mono text-muted">{path}</span>
        {note && <span className="text-muted">{note}</span>}
        {hasBase && (
          <div className="flex overflow-hidden rounded-md border border-border">
            {(['file', 'diff'] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={cn('px-2 py-0.5', mode === m ? 'bg-accent-soft text-accent' : 'text-muted hover:text-ink')}
                onClick={() => setMode(m)}
                data-testid={`file-mode-${m}`}
              >
                {m === 'file' ? 'Fichier' : 'Diff'}
              </button>
            ))}
          </div>
        )}
      </div>
      {unreadable ? (
        <div className="flex-1" />
      ) : (
        <div className="min-h-0 flex-1">
          <CodeView text={work.text ?? ''} base={base?.text ?? ''} mode={hasBase ? mode : 'file'} language={languageFor(path)} />
        </div>
      )}
    </div>
  )
}
