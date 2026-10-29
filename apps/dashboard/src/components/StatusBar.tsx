/**
 * @file Bandeau supérieur : état de la connexion et santé du daemon.
 *
 * L'état de la connexion est affiché en permanence, et c'est important : un
 * dashboard temps réel qui a perdu sa WebSocket continue d'afficher des données
 * d'apparence normale. Sans ce témoin, on croirait qu'il ne se passe rien.
 */
import { Activity, CircleAlert, Database, Plug, PlugZap, Timer } from 'lucide-react'
import type { Health } from '@midgaard/contracts'
import type { ConnectionStatus } from '@/lib/useHarness'
import { Badge } from './ui/badge'

const CONNECTION: Record<ConnectionStatus, { label: string; tone: 'running' | 'done' | 'danger' }> = {
  connecting: { label: 'connexion…', tone: 'running' },
  open: { label: 'en direct', tone: 'done' },
  closed: { label: 'déconnecté', tone: 'danger' },
}

/** Millisecondes en texte court, pour le compte à rebours d'inactivité. */
function shortDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`
  return `${Math.round(ms / 60_000)} min`
}

export function StatusBar({
  status,
  health,
  error,
  gap,
}: {
  status: ConnectionStatus
  health: Health | null
  error: string | null
  gap: boolean
}) {
  const connection = CONNECTION[status]
  return (
    <header className="border-b border-border bg-surface">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-5 py-3">
        <div className="flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded-md bg-accent-soft text-accent">
            <Activity className="size-4" />
          </span>
          <span className="font-semibold tracking-tight">Midgaard</span>
        </div>

        <Badge tone={connection.tone}>
          {status === 'open' ? <PlugZap className="size-3" /> : <Plug className="size-3" />}
          {connection.label}
        </Badge>

        {health && (
          <>
            <span className="text-xs text-muted">pid {health.pid} · protocole {health.protocol}</span>
            <span className="flex items-center gap-1.5 text-xs text-muted" title={health.db_path}>
              <Database className="size-3.5" />
              {health.tasks.total} tâche(s), {health.tasks.active} active(s)
            </span>
            {health.idle_shutdown_in_ms !== null && (
              <span
                className="flex items-center gap-1.5 text-xs text-muted"
                title="Le daemon s'arrête après une période sans tâche active, sans dashboard connecté et sans requête."
              >
                <Timer className="size-3.5" />
                arrêt auto dans {shortDuration(health.idle_shutdown_in_ms)}
              </span>
            )}
          </>
        )}
      </div>

      {(error || gap) && (
        <div className="flex flex-col gap-1 border-t border-danger/30 bg-danger/10 px-5 py-2 text-xs text-danger">
          {error && (
            <span className="flex items-center gap-2">
              <CircleAlert className="size-3.5" /> {error}
            </span>
          )}
          {gap && (
            <span className="flex items-center gap-2">
              <CircleAlert className="size-3.5" />
              Reconnexion trop tardive : l'historique intermédiaire n'a pas pu être rejoué. L'état courant
              est à jour ; ouvre une tâche pour recharger sa timeline complète.
            </span>
          )}
        </div>
      )}
    </header>
  )
}
