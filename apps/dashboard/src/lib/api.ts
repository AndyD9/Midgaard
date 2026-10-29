/**
 * @file Accès à l'API du daemon depuis le navigateur.
 *
 * Le dashboard n'a aucun jeton au chargement : il est servi par le daemon, sur
 * la même origine, et récupère le jeton d'API en appelant `/ui/bootstrap`. Cette
 * route n'exige pas de jeton — le navigateur n'en a pas encore — mais reste
 * protégée par les contrôles d'enveloppe du daemon (`Host` exact, `Origin` en
 * liste blanche, `Sec-Fetch-Site`), qui sont précisément ce qui arrête une page
 * hostile. Le détail du modèle de menace est dans `packages/daemon/README.md`.
 *
 * Le jeton reste en mémoire : ni `localStorage`, ni cookie, ni URL. Il change à
 * chaque démarrage du daemon, et un rechargement de page le redemande.
 */
import type { Agent, Approval, Health, ProviderConfig, Task, TaskEvent, ToolCall } from '@midgaard/contracts'

/** Jeton d'API, en mémoire uniquement. */
let token: string | null = null

/**
 * Bootstrap en vol, s'il y en a un.
 *
 * Plusieurs composants demandent des données au même instant, et chacun aurait
 * sinon déclenché son propre `/ui/bootstrap`. Un seul suffit, et les autres
 * attendent celui-là.
 */
let pending: Promise<{ token: string; health: Health }> | null = null

/** Erreur d'API portant le code HTTP, pour que l'appelant puisse le distinguer. */
export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/**
 * Récupère le jeton d'API et l'état de santé initial.
 * @throws {ApiError} si le daemon refuse ou ne répond pas
 */
export function bootstrap(): Promise<{ token: string; health: Health }> {
  pending ??= (async () => {
    const res = await fetch('/ui/bootstrap', { headers: { accept: 'application/json' } })
    if (!res.ok) throw new ApiError(res.status, `bootstrap refusé (${res.status})`)
    const body = (await res.json()) as { token: string; health: Health }
    token = body.token
    return body
  })()
  // Un échec ne reste pas mémorisé : la reconnexion doit pouvoir redemander.
  return pending.catch((e: unknown) => {
    pending = null
    throw e
  })
}

/** Jeton courant, nécessaire pour ouvrir la WebSocket. */
export function currentToken(): string | null {
  return token
}

/**
 * Oublie le jeton courant.
 *
 * À appeler quand la WebSocket se ferme : le jeton est **régénéré à chaque
 * démarrage du daemon**, donc un daemon redémarré en invalide un sans que rien
 * ne le dise. Sans cet oubli, `connect()` voyait un jeton non nul, sautait le
 * bootstrap, et réessayait indéfiniment avec une valeur périmée — la page
 * restait « déconnecté » jusqu'à un rechargement manuel.
 */
export function forgetToken(): void {
  token = null
  pending = null
}

/**
 * Appelle l'API authentifiée.
 * @throws {ApiError} sur réponse non 2xx, avec le message d'erreur du daemon
 */
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  // Obtenir le jeton **avant** d'appeler, plutôt que d'espérer qu'un autre
  // l'ait déjà fait. React exécute les effets des enfants avant ceux du parent :
  // `AgentsCard` demandait donc ses données avant que `useHarness` n'ait
  // seulement lancé le bootstrap, recevait 401, et son `catch` vide la faisait
  // disparaître — la carte qui existe précisément pour dire à un nouveau venu
  // qu'aucun fournisseur n'est configuré était absente de son écran d'accueil.
  // Trouvé par le rendu, invisible pour un test de fonctions pures.
  if (!token) await bootstrap()
  const res = await fetch(path, {
    ...init,
    headers: {
      ...init.headers,
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  })
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new ApiError(res.status, body.error ?? `erreur ${res.status}`)
  return body as T
}

/** Timeline complète d'une tâche. */
export function fetchTaskEvents(taskId: string): Promise<{ events: TaskEvent[] }> {
  return api(`/api/tasks/${taskId}/events`)
}

/** Approuve une demande. `by: 'dashboard'` est tracé dans l'historique. */
export function approve(approvalId: string): Promise<{ task: Task }> {
  return api(`/api/approvals/${approvalId}/approve`, {
    method: 'POST',
    body: JSON.stringify({ by: 'dashboard' }),
  })
}

/** Refuse une demande, avec un motif facultatif transmis à la tâche. */
export function reject(approvalId: string, reason?: string): Promise<{ task: Task }> {
  return api(`/api/approvals/${approvalId}/reject`, {
    method: 'POST',
    body: JSON.stringify({ by: 'dashboard', reason }),
  })
}

/** Demande l'annulation d'une tâche. */
export function cancelTask(taskId: string, reason?: string): Promise<{ task: Task }> {
  return api(`/api/tasks/${taskId}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) })
}

/** Appels d'outils d'une tâche, dans l'ordre où ils ont été demandés. */
export function fetchToolCalls(taskId: string): Promise<{ tool_calls: ToolCall[] }> {
  return api(`/api/tasks/${taskId}/tools`)
}

/** Profils d'agents déclarés, avec leur état d'activation. */
export function fetchAgents(): Promise<{ agents: Agent[] }> {
  return api('/api/agents')
}

/**
 * Fournisseurs déclarés et date des tarifs.
 *
 * Ne contient **aucune clé** : `ProviderConfig` ne porte qu'une référence vers
 * le coffre. Le dashboard n'en voit jamais une.
 */
export function fetchProviders(): Promise<{
  providers: ProviderConfig[]
  pricing: { updated_at: string; source: string; models: number }
}> {
  return api('/api/providers')
}

/** Approbations en attente, pour un rafraîchissement ponctuel. */
export function fetchApprovals(): Promise<{ approvals: Approval[] }> {
  return api('/api/approvals')
}
