/**
 * @file Application du dashboard : deux colonnes, la liste et le panneau principal.
 *
 * Le routage se fait par le fragment d'URL, sans bibliothèque. Trois routes :
 * `#/tasks/<id>` (une tâche — un lien d'approbation doit pouvoir y pointer),
 * et depuis la Slice 5 `#/new` (le formulaire « Nouvelle tâche ») et `#/agents`
 * (les profils, leur fournisseur et leur modèle). Le daemon sert `index.html`
 * pour toute route inconnue, donc un rechargement fonctionne aussi.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, SlidersHorizontal } from 'lucide-react'
import { useHarness } from '@/lib/useHarness'
import { AgentsCard } from './components/AgentsCard'
import { NewTaskForm } from './components/NewTaskForm'
import { StatusBar } from './components/StatusBar'
import { TaskInspector } from './components/TaskInspector'
import { TaskList } from './components/TaskList'
import { Button } from './components/ui/button'

/** Ce que montre le panneau principal, lu dans le fragment d'URL. */
type View = { kind: 'task'; id: string } | { kind: 'new' } | { kind: 'agents' } | { kind: 'none' }

/** Vue désignée par le fragment courant. */
function viewFromHash(): View {
  if (location.hash === '#/new') return { kind: 'new' }
  if (location.hash === '#/agents') return { kind: 'agents' }
  const match = /^#\/tasks\/([0-9a-f-]{36})$/i.exec(location.hash)
  return match ? { kind: 'task', id: match[1]! } : { kind: 'none' }
}

export function App() {
  const { state, loadEvents, reportError } = useHarness()
  const [view, setView] = useState<View>(viewFromHash)
  const selectedId = view.kind === 'task' ? view.id : null

  // Le fragment est la source de vérité de la vue : les boutons Précédent et
  // Suivant du navigateur fonctionnent, et un lien partagé ouvre la bonne tâche.
  useEffect(() => {
    const onHashChange = () => setView(viewFromHash())
    addEventListener('hashchange', onHashChange)
    return () => removeEventListener('hashchange', onHashChange)
  }, [])

  const select = useCallback((id: string) => {
    location.hash = `#/tasks/${id}`
  }, [])

  // À défaut de sélection, on ouvre ce qui attend une décision, sinon la tâche
  // la plus récente : ouvrir le dashboard doit montrer quelque chose d'utile.
  const effectiveId = useMemo(() => {
    if (view.kind === 'new' || view.kind === 'agents') return null
    if (selectedId && state.tasks.some((t) => t.id === selectedId)) return selectedId
    return state.approvals[0]?.task_id ?? state.tasks[0]?.id ?? null
  }, [view.kind, selectedId, state.tasks, state.approvals])

  // Ce choix par défaut devient aussitôt une sélection explicite, inscrite dans
  // le fragment. Sans cela, il serait recalculé à chaque changement d'état : la
  // tâche qu'on regarde s'échapperait au moment même où on l'approuve, puisqu'elle
  // cesse alors d'être celle qui attend une décision.
  useEffect(() => {
    if (view.kind === 'none' && effectiveId) select(effectiveId)
  }, [view.kind, effectiveId, select])

  const task = state.tasks.find((t) => t.id === effectiveId) ?? null
  const approval = state.approvals.find((a) => a.task_id === effectiveId) ?? null

  return (
    <div className="flex h-full flex-col">
      <StatusBar status={state.status} health={state.health} error={state.error} gap={state.gap} />

      <main className="grid min-h-0 flex-1 lg:grid-cols-[22rem_1fr]">
        <aside className="min-h-0 overflow-y-auto border-border lg:border-r">
          <div className="sticky top-0 z-10 flex items-center gap-1 border-b border-border bg-surface px-4 py-1.5">
            <h1 className="mr-auto text-xs font-semibold tracking-wide text-muted uppercase">Tâches</h1>
            <Button size="sm" variant="ghost" onClick={() => (location.hash = '#/agents')} data-testid="nav-agents">
              <SlidersHorizontal /> Profils
            </Button>
            <Button size="sm" onClick={() => (location.hash = '#/new')} data-testid="nav-new">
              <Plus /> Nouvelle tâche
            </Button>
          </div>
          <TaskList
            tasks={state.tasks}
            approvals={state.approvals}
            selectedId={effectiveId}
            onSelect={select}
          />
        </aside>

        <section className="min-h-0 overflow-y-auto p-5">
          {view.kind === 'new' ? (
            <NewTaskForm onCreated={select} />
          ) : view.kind === 'agents' ? (
            <div className="mx-auto max-w-2xl">
              <AgentsCard editable />
            </div>
          ) : task ? (
            <TaskInspector
              task={task}
              tasks={state.tasks}
              approval={approval}
              events={state.events[task.id]}
              onLoadEvents={loadEvents}
              onError={reportError}
              onSelect={select}
            />
          ) : (
            <Empty />
          )}
        </section>
      </main>
    </div>
  )
}

/**
 * Écran vide : il explique quoi faire, plutôt que de rester muet.
 *
 * Il montre aussi l'état réel des exécutants. Quelqu'un qui ouvre le dashboard
 * sans avoir configuré de clé doit l'apprendre **ici**, et non en voyant sa
 * première délégation refusée.
 */
function Empty() {
  return (
    <div className="mx-auto max-w-xl space-y-5 pt-10">
      <div className="space-y-3 text-center">
        <h2 className="text-lg font-semibold">Rien à observer pour l'instant</h2>
        <p className="text-sm text-muted">
          Lance une tâche avec « Nouvelle tâche », ou ouvre une session Claude Code sur un dossier où le
          serveur <code className="font-mono">midgaard</code> est déclaré, et demande-lui de déléguer. Elle
          apparaîtra ici en direct.
        </p>
      </div>
      <AgentsCard />
    </div>
  )
}
