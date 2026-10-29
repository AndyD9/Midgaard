/**
 * @file Liste des tâches, colonne de gauche.
 *
 * Triée de la plus récente à la plus ancienne. Les tâches qui attendent une
 * décision humaine sont signalées là aussi, et pas seulement dans l'inspecteur :
 * c'est la seule chose dans ce dashboard qui **bloque** quelqu'un.
 */
import { CircleDot } from 'lucide-react'
import type { Approval, Task } from '@midgaard/contracts'
import { cn, formatDateTime, formatTime } from '@/lib/utils'
import { Badge, toneForStatus } from './ui/badge'

export function TaskList({
  tasks,
  approvals,
  selectedId,
  onSelect,
}: {
  tasks: Task[]
  approvals: Approval[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const awaiting = new Set(approvals.map((a) => a.task_id))

  if (tasks.length === 0) {
    return (
      <p className="px-4 py-6 text-sm text-muted">
        Aucune tâche. Depuis une session Claude Code, demande au harness de déléguer quelque chose.
      </p>
    )
  }

  return (
    <ul className="divide-y divide-border">
      {tasks.map((task) => (
        <li key={task.id}>
          <button
            type="button"
            onClick={() => onSelect(task.id)}
            aria-current={task.id === selectedId}
            className={cn(
              'w-full px-4 py-3 text-left transition-colors hover:bg-canvas',
              task.id === selectedId && 'bg-accent-soft hover:bg-accent-soft',
            )}
          >
            <div className="flex items-center gap-2">
              <Badge tone={toneForStatus(task.status)}>{task.status}</Badge>
              {awaiting.has(task.id) && (
                <span className="flex items-center gap-1 text-xs font-medium text-waiting">
                  <CircleDot className="size-3" /> décision requise
                </span>
              )}
              <span className="ml-auto font-mono text-[11px] text-muted" title={formatDateTime(task.created_at)}>
                {formatTime(task.created_at)}
              </span>
            </div>
            <p className="mt-1.5 line-clamp-2 text-sm">{task.objective}</p>
            <p className="mt-1 font-mono text-[11px] text-muted">
              {task.id.slice(0, 8)} · étape {task.step}/{task.steps_total}
            </p>
          </button>
        </li>
      ))}
    </ul>
  )
}
