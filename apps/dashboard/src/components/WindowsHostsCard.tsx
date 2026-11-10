/**
 * @file Les VM Windows de test déclarées (Slice 9, étape 6) : leur dernier
 * test, et les profils qui les portent.
 *
 * **Ce qui ne se fait pas ici** : déclarer, tester ou retirer une VM. La clé
 * est générée par le daemon et rangée au coffre, l'empreinte d'hôte se recopie
 * depuis la console de la VM, et la clé publique se pose sur la VM par des
 * commandes PowerShell — tout cela passe par la CLI, où rien de secret ne
 * traverse un navigateur. La carte donne les commandes exactes.
 *
 * **Ce qui se fait ailleurs** : attacher une VM à un profil Developer se fait
 * sur la carte « Exécutants » juste au-dessus (un sélecteur par profil), ou par
 * `npm run harness -- windows attach`. La carte montre ici quels profils
 * portent chaque VM, pour que l'humain voie d'un coup d'œil ce qui est branché.
 */
import { useEffect, useState } from 'react'
import { MonitorDown } from 'lucide-react'
import type { Agent, WindowsHostView } from '@midgaard/contracts'
import { fetchAgents, fetchWindows } from '@/lib/api'
import { formatDateTime } from '@/lib/utils'
import { Badge } from './ui/badge'
import { Card, CardBody, CardHeader, CardTitle } from './ui/card'

/** La commande qui déclare une VM, à recopier dans un terminal, à la racine du dépôt. */
const DECLARE_EXAMPLE = 'npm run harness -- windows add vm1 --host 192.168.64.5 --user analyste --fingerprint "SHA256:…"'

/** La carte des VM Windows de test, dans la vue « Profils ». */
export function WindowsHostsCard() {
  const [hosts, setHosts] = useState<WindowsHostView[] | null>(null)
  const [agents, setAgents] = useState<Agent[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let abandoned = false
    Promise.all([fetchWindows(), fetchAgents().catch(() => ({ agents: [] }))])
      .then(([w, a]) => {
        if (!abandoned) {
          setHosts(w.hosts)
          setAgents(a.agents)
        }
      })
      .catch((e: unknown) => !abandoned && setError((e as Error).message))
    return () => {
      abandoned = true
    }
  }, [])

  /** Les profils qui portent une VM : montrés pour qu'on voie ce qui est branché. */
  const owners = (id: string) => agents.filter((a) => a.windows_host === id).map((a) => a.id)

  return (
    <Card data-testid="windows-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MonitorDown className="size-4 text-muted" /> VM Windows de test
        </CardTitle>
        <span className="text-xs text-muted">{hosts ? `${hosts.length} déclarée(s)` : ''}</span>
      </CardHeader>
      <CardBody className="space-y-3 text-sm">
        {error && <p className="text-xs text-danger">{error}</p>}
        {hosts?.length === 0 && (
          <p className="text-xs text-muted" data-testid="windows-empty">
            Aucune VM déclarée. Dans un terminal, à la racine du dépôt :{' '}
            <code className="rounded bg-canvas px-1 font-mono">{DECLARE_EXAMPLE}</code>
          </p>
        )}
        {hosts?.map((h) => {
          const t = h.last_test
          const who = owners(h.id)
          return (
            <div key={h.id} className="space-y-1 border-b border-border pb-2 last:border-0" data-testid={`windows-host-${h.id}`}>
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs">{h.id}</span>
                <Badge tone={t ? (t.ok ? 'done' : 'danger') : 'neutral'} data-testid={`windows-test-badge-${h.id}`}>
                  {t ? (t.ok ? 'répond' : 'échec') : 'jamais testée'}
                </Badge>
                <span className="text-xs text-muted">
                  {h.username}@{h.host}:{h.port}
                </span>
              </div>
              <p className="font-mono text-xs text-muted">{h.fingerprint}</p>
              {t && (
                <p className={t.ok ? 'text-xs text-done' : 'text-xs text-danger'}>
                  {t.detail}
                  {t.at ? <span className="text-muted"> — {formatDateTime(t.at)}</span> : null}
                </p>
              )}
              <p className="text-xs text-muted">
                {who.length ? `attachée à : ${who.join(', ')}` : 'attachée à aucun profil'}
              </p>
            </div>
          )
        })}
        <p className="border-t border-border pt-3 text-xs text-muted">
          Une VM se déclare, se teste et se retire depuis un terminal, à la racine du dépôt (
          <code className="font-mono">npm run harness -- windows add</code>,{' '}
          <code className="font-mono">windows test</code>,{' '}
          <code className="font-mono">windows remove</code>) : sa clé est générée au coffre et ne traverse jamais le
          navigateur, et son empreinte d'hôte se recopie depuis la console de la VM. Elle s'attache à un profil Developer
          ci-dessus, ou par <code className="font-mono">npm run harness -- windows attach vm1 developer</code>.
        </p>
      </CardBody>
    </Card>
  )
}
