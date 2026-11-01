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
 * **Les clés ne passent jamais par ici** : déposer une clé d'API passe par la
 * CLI, où elle peut être saisie sans écho et sans traverser un navigateur.
 *
 * **Ce qui s'y règle, depuis la Slice 5** (`editable`, vue « Profils ») : le
 * fournisseur et le modèle de chaque profil, par `PATCH /api/agents/:id`. Rien
 * d'autre — les limites restent hors de portée de l'API, et donc d'ici.
 */
import { useCallback, useEffect, useState } from 'react'
import { Bot, Save } from 'lucide-react'
import type { Agent, ProviderConfig } from '@midgaard/contracts'
import { ApiError, fetchAgents, fetchProviders, updateAgent } from '@/lib/api'
import { disabledReason } from '@/lib/agents'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Card, CardBody, CardHeader, CardTitle } from './ui/card'

interface Loaded {
  agents: Agent[]
  providers: ProviderConfig[]
  pricing: { updated_at: string; models: number }
}

/**
 * La carte des exécutants.
 * @param editable vrai dans la vue « Profils » : fournisseur et modèle se règlent
 */
export function AgentsCard({ editable = false }: { editable?: boolean }) {
  const [data, setData] = useState<Loaded | null>(null)

  const load = useCallback(() => {
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

  useEffect(load, [load])

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
            <li key={agent.id} className="space-y-1" data-testid={`agent-${agent.id}`}>
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs">{agent.id}</span>
                <Badge tone={agent.enabled ? 'done' : 'neutral'}>
                  {agent.enabled ? 'disponible' : 'désactivé'}
                </Badge>
                {agent.provider_id && (
                  <span className="text-xs text-muted">
                    via {agent.provider_id}
                    {agent.model ? ` · ${agent.model}` : ''}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted">{agent.description}</p>
              {!agent.enabled && (
                <p className="text-xs text-waiting">
                  {disabledReason(agent, data.providers)}. Dans un terminal, à la racine du dépôt :{' '}
                  <code className="rounded bg-canvas px-1 font-mono">
                    npm run harness -- providers add venice --model deepseek-v4-flash-0731
                  </code>
                </p>
              )}
              {editable && agent.kind !== 'simulated' && data.providers.length > 0 && (
                <ModelEditor agent={agent} providers={data.providers} onSaved={load} />
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

/**
 * Fournisseur et modèle d'un profil, réglés par `PATCH /api/agents/:id`.
 *
 * Le modèle est un champ libre, aidé des modèles que le dernier « Test
 * connection » du fournisseur a listés : le harness ne connaît pas le catalogue
 * de chaque fournisseur, et un champ fermé interdirait un modèle sorti hier.
 * Vide, il revient au modèle par défaut du fournisseur. Changer de fournisseur
 * sans modèle fait de même côté daemon : un nom de modèle n'a de sens que chez
 * son fournisseur.
 */
function ModelEditor({
  agent,
  providers,
  onSaved,
}: {
  agent: Agent
  providers: ProviderConfig[]
  onSaved: () => void
}) {
  const [providerId, setProviderId] = useState(agent.provider_id ?? providers[0]!.id)
  const [model, setModel] = useState(agent.model ?? '')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const provider = providers.find((p) => p.id === providerId)
  const changed = providerId !== agent.provider_id || (model.trim() || null) !== agent.model
  const listId = `models-${agent.id}`

  async function save(): Promise<void> {
    setSaving(true)
    setMessage(null)
    try {
      const { agent: saved } = await updateAgent(agent.id, { provider_id: providerId, model: model.trim() || null })
      setMessage({ ok: true, text: `enregistré : ${saved.provider_id} · ${saved.model ?? 'modèle par défaut'}` })
      onSaved()
    } catch (e) {
      setMessage({ ok: false, text: e instanceof ApiError && e.reason ? e.reason : (e as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <select
        className="rounded-md border border-border bg-surface px-2 py-1 text-xs"
        value={providerId}
        onChange={(e) => setProviderId(e.target.value)}
        aria-label={`Fournisseur de ${agent.id}`}
        data-testid={`agent-provider-${agent.id}`}
      >
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.id}
          </option>
        ))}
      </select>
      <input
        className="min-w-48 flex-1 rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs"
        value={model}
        onChange={(e) => setModel(e.target.value)}
        placeholder={provider ? `par défaut : ${provider.default_model}` : 'modèle'}
        list={listId}
        spellCheck={false}
        aria-label={`Modèle de ${agent.id}`}
        data-testid={`agent-model-${agent.id}`}
      />
      <datalist id={listId}>
        {(provider?.last_test?.models ?? []).map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      <Button
        size="sm"
        variant="outline"
        onClick={save}
        disabled={!changed || saving}
        data-testid={`agent-save-${agent.id}`}
      >
        <Save /> Enregistrer
      </Button>
      {message && (
        <span className={message.ok ? 'text-xs text-done' : 'text-xs text-danger'} role="status">
          {message.text}
        </span>
      )}
    </div>
  )
}
