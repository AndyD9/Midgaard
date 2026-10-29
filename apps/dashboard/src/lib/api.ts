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
import type { Approval, Health, Task, TaskEvent } from '@midgaard/contracts'

/** Jeton d'API, en mémoire uniquement. */
let token: string | null = null

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
export async function bootstrap(): Promise<{ token: string; health: Health }> {
  const res = await fetch('/ui/bootstrap', { headers: { accept: 'application/json' } })
  if (!res.ok) throw new ApiError(res.status, `bootstrap refusé (${res.status})`)
  const body = (await res.json()) as { token: string; health: Health }
  token = body.token
  return body
}

/** Jeton courant, nécessaire pour ouvrir la WebSocket. */
export function currentToken(): string | null {
  return token
}

/**
 * Appelle l'API authentifiée.
 * @throws {ApiError} sur réponse non 2xx, avec le message d'erreur du daemon
 */
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
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

/** Approbations en attente, pour un rafraîchissement ponctuel. */
export function fetchApprovals(): Promise<{ approvals: Approval[] }> {
  return api('/api/approvals')
}
