/**
 * @file Ce qui est configuré : profils d'agents et fournisseurs de modèles.
 *
 * **Pourquoi cette carte existe.** Le premier essai réel de la Slice 0 a échoué
 * parce que le harness décrivait un dashboard qui n'existait pas. La leçon vaut
 * ici : un Researcher présenté comme disponible alors qu'aucune clé n'est
 * configurée enverrait l'utilisateur déléguer une tâche qui ne peut pas
 * démarrer. Cette carte montre donc l'état réel — profil désactivé compris — et
 * donne la commande exacte pour y remédier.
 *
 * Lecture seule, et c'est assumé : déposer une clé d'API passe par la CLI, où
 * elle peut être saisie sans écho et sans traverser un navigateur.
 */
import { useEffect, useState } from 'react'
import { Bot } from 'lucide-react'
import type { Agent, ProviderConfig } from '@midgaard/contracts'
import { fetchAgents, fetchProviders } from '@/lib/api'
import { Badge } from './ui/badge'
import { Card, CardBody, CardHeader, CardTitle } from './ui/card'

interface Loaded {
  agents: Agent[]
  providers: ProviderConfig[]
  pricing: { updated_at: string; models: number }
}

export function AgentsCard() {
  const [data, setData] = useState<Loaded | null>(null)

  useEffect(() => {
    let abandoned = false
    Promise.all([fetchAgents(), fetchProviders()])
      .then(([a, p]) => {
        if (!abandoned) setData({ agents: a.agents, providers: p.providers, pricing: p.pricing })
      })
      .catch(() => {})
    return () => {
      abandoned = true
    }
  }, [])

  if (!data) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="size-4 text-muted" /> Exécutants
        </CardTitle>
        <span className="text-xs text-muted">
          {data.providers.length} fournisseur(s) · {data.pricing.models} tarif(s)
        </span>
      </CardHeader>
      <CardBody className="space-y-3 text-sm">
        <ul className="space-y-2">
          {data.agents.map((agent) => (
            <li key={agent.id} className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs">{agent.id}</span>
                <Badge tone={agent.enabled ? 'done' : 'neutral'}>
                  {agent.enabled ? 'disponible' : 'désactivé'}
                </Badge>
                {agent.provider_id && <span className="text-xs text-muted">via {agent.provider_id}</span>}
              </div>
              <p className="text-xs text-muted">{agent.description}</p>
              {!agent.enabled && (
                <p className="text-xs text-waiting">
                  Aucun fournisseur de modèle configuré. Dans un terminal, à la racine du dépôt :{' '}
                  <code className="rounded bg-canvas px-1 font-mono">
                    npm run harness -- providers add venice --model qwen3-235b-a22b-instruct-2507
                  </code>
                </p>
              )}
            </li>
          ))}
        </ul>

        {data.providers.length > 0 && (
          <ul className="space-y-1 border-t border-border pt-3">
            {data.providers.map((p) => (
              <li key={p.id} className="flex items-center gap-2 text-xs">
                <span className="font-mono">{p.id}</span>
                <span className="text-muted">{p.default_model}</span>
                <Badge tone={p.last_test?.ok ? 'done' : p.last_test ? 'danger' : 'neutral'}>
                  {p.last_test ? (p.last_test.ok ? 'joignable' : 'injoignable') : 'jamais testé'}
                </Badge>
              </li>
            ))}
          </ul>
        )}

        <p className="border-t border-border pt-3 text-xs text-muted">
          Tarifs relevés le {data.pricing.updated_at.slice(0, 10)}. Un coût affiché « estimé » vient de cette
          table ; un coût « facturé » vient du fournisseur lui-même.
        </p>
      </CardBody>
    </Card>
  )
}
