/**
 * @file Inspecteur de tâche : tout ce qu'on sait d'une tâche, au même endroit.
 *
 * L'ordre de haut en bas suit ce qu'on cherche quand on ouvre une tâche :
 * est-ce que quelque chose m'attend (approbation), où en est-ce (état et
 * progression), qu'est-ce qui en est sorti (résultat ou erreur), et enfin ce qui
 * s'est passé (timeline).
 */
import { useEffect, useState } from 'react'
import { Ban } from 'lucide-react'
import type { Approval, Task, TaskEvent } from '@midgaard/contracts'
import { cancelTask } from '@/lib/api'
import { duration, formatDateTime } from '@/lib/utils'
import { ApprovalPanel } from './ApprovalPanel'
import { Timeline } from './Timeline'
import { Badge, toneForStatus } from './ui/badge'
import { Button } from './ui/button'
import { Card, CardBody, CardHeader, CardTitle } from './ui/card'

/** Statuts depuis lesquels une annulation a encore un sens. */
const CANCELLABLE = ['queued', 'preparing', 'running', 'waiting_approval']

export function TaskInspector({
  task,
  approval,
  events,
  onLoadEvents,
  onError,
}: {
  task: Task
  approval: Approval | null
  events: TaskEvent[] | undefined
  onLoadEvents: (taskId: string) => void
  onError: (message: string | null) => void
}) {
  const [cancelling, setCancelling] = useState(false)

  // La timeline est chargée entière à l'ouverture, puis tenue à jour par la
  // WebSocket. Un affichage partiel qui commencerait à la connexion serait pire
  // que pas de timeline : il serait faux sans le dire.
  useEffect(() => {
    if (!events) onLoadEvents(task.id)
  }, [task.id, events, onLoadEvents])

  async function cancel(): Promise<void> {
    setCancelling(true)
    onError(null)
    try {
      await cancelTask(task.id, 'annulée depuis le dashboard')
    } catch (e) {
      onError(`annulation refusée : ${(e as Error).message}`)
    } finally {
      setCancelling(false)
    }
  }

  const elapsed = duration(task.created_at, task.ended_at)

  return (
    <div className="space-y-4">
      {approval && <ApprovalPanel approval={approval} onError={onError} />}

      <Card>
        <CardHeader>
          <div className="min-w-0 space-y-1.5">
            <CardTitle className="text-base">{task.objective}</CardTitle>
            <p className="font-mono text-[11px] text-muted">{task.id}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge tone={toneForStatus(task.status)}>{task.status}</Badge>
            {CANCELLABLE.includes(task.status) && (
              <Button variant="outline" size="sm" onClick={cancel} disabled={cancelling}>
                <Ban /> Annuler
              </Button>
            )}
          </div>
        </CardHeader>
        <CardBody className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Field label="Progression" value={`étape ${task.step} sur ${task.steps_total}`} />
          <Field label="Durée simulée" value={`${task.duration_s} s`} />
          <Field label="Créée" value={formatDateTime(task.created_at)} />
          <Field label="Terminée" value={task.ended_at ? formatDateTime(task.ended_at) : '—'} />
          {elapsed && <Field label="Temps écoulé" value={elapsed} />}
        </CardBody>
      </Card>

      {task.error && (
        <Card className="border-danger/40">
          <CardHeader>
            <CardTitle className="text-danger">Fin anormale</CardTitle>
          </CardHeader>
          <CardBody className="text-sm">{task.error}</CardBody>
        </Card>
      )}

      {task.result && (
        <Card>
          <CardHeader>
            <CardTitle>Résultat</CardTitle>
          </CardHeader>
          <CardBody className="space-y-2 text-sm">
            <p>{task.result.summary}</p>
            {task.result.steps.length > 0 && (
              <ul className="list-inside list-disc space-y-0.5 text-muted">
                {task.result.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
          <span className="text-xs text-muted">{events?.length ?? 0} événement(s)</span>
        </CardHeader>
        <Timeline events={events} />
      </Card>
    </div>
  )
}

/** Paire libellé / valeur, alignée sur deux colonnes. */
function Field({ label, value }: { label: string; value: string }) {
  return (
    <p className="flex gap-2">
      <span className="text-muted">{label} :</span>
      <span className="min-w-0 truncate">{value}</span>
    </p>
  )
}
