/**
 * @file Application du dashboard : deux colonnes, la liste et l'inspecteur.
 *
 * Le routage se fait par le fragment d'URL (`#/tasks/<id>`), sans bibliothèque :
 * une seule route, et un lien d'approbation doit pouvoir pointer directement sur
 * une tâche. Le daemon sert `index.html` pour toute route inconnue, donc un
 * rechargement fonctionne aussi.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useHarness } from '@/lib/useHarness'
import { AgentsCard } from './components/AgentsCard'
import { StatusBar } from './components/StatusBar'
import { TaskInspector } from './components/TaskInspector'
import { TaskList } from './components/TaskList'

/** Identifiant de tâche lu dans le fragment `#/tasks/<id>`. */
function taskIdFromHash(): string | null {
  const match = /^#\/tasks\/([0-9a-f-]{36})$/i.exec(location.hash)
  return match ? match[1]! : null
}

export function App() {
  const { state, loadEvents, reportError } = useHarness()
  const [selectedId, setSelectedId] = useState<string | null>(taskIdFromHash)

  // Le fragment est la source de vérité de la sélection : les boutons Précédent
  // et Suivant du navigateur fonctionnent, et un lien partagé ouvre la bonne tâche.
  useEffect(() => {
    const onHashChange = () => setSelectedId(taskIdFromHash())
    addEventListener('hashchange', onHashChange)
    return () => removeEventListener('hashchange', onHashChange)
  }, [])

  const select = useCallback((id: string) => {
    location.hash = `#/tasks/${id}`
  }, [])

  // À défaut de sélection, on ouvre ce qui attend une décision, sinon la tâche
  // la plus récente : ouvrir le dashboard doit montrer quelque chose d'utile.
  const effectiveId = useMemo(() => {
    if (selectedId && state.tasks.some((t) => t.id === selectedId)) return selectedId
    return state.approvals[0]?.task_id ?? state.tasks[0]?.id ?? null
  }, [selectedId, state.tasks, state.approvals])

  // Ce choix par défaut devient aussitôt une sélection explicite, inscrite dans
  // le fragment. Sans cela, il serait recalculé à chaque changement d'état : la
  // tâche qu'on regarde s'échapperait au moment même où on l'approuve, puisqu'elle
  // cesse alors d'être celle qui attend une décision.
  useEffect(() => {
    if (!selectedId && effectiveId) select(effectiveId)
  }, [selectedId, effectiveId, select])

  const task = state.tasks.find((t) => t.id === effectiveId) ?? null
  const approval = state.approvals.find((a) => a.task_id === effectiveId) ?? null

  return (
    <div className="flex h-full flex-col">
      <StatusBar status={state.status} health={state.health} error={state.error} gap={state.gap} />

      <main className="grid min-h-0 flex-1 lg:grid-cols-[22rem_1fr]">
        <aside className="min-h-0 overflow-y-auto border-border lg:border-r">
          <h1 className="sticky top-0 border-b border-border bg-surface px-4 py-2.5 text-xs font-semibold tracking-wide text-muted uppercase">
            Tâches
          </h1>
          <TaskList
            tasks={state.tasks}
            approvals={state.approvals}
            selectedId={effectiveId}
            onSelect={select}
          />
        </aside>

        <section className="min-h-0 overflow-y-auto p-5">
          {task ? (
            <TaskInspector
              task={task}
              approval={approval}
              events={state.events[task.id]}
              onLoadEvents={loadEvents}
              onError={reportError}
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
          Ouvre une session Claude Code sur un dossier où le serveur{' '}
          <code className="font-mono">midgaard</code> est déclaré, et demande-lui de déléguer une tâche.
          Elle apparaîtra ici en direct.
        </p>
      </div>
      <AgentsCard />
    </div>
  )
}
