/**
 * @file Ce que l'atelier sait du navigateur d'une tâche (Slice 7, étape 6),
 * reconstitué depuis le journal. Fonctions pures, sans rendu.
 *
 * Le journal raconte la session — `browser.opened`, les appels d'outil
 * `browser_*`, `browser.closed` — sans jamais porter une capture : la dernière
 * vit dans la mémoire du daemon, et l'onglet « Navigateur » la redemande chaque
 * fois qu'un événement dit qu'elle a pu changer ({@link BrowserSummary.frameSeq}).
 */
import type { TaskEvent } from '@midgaard/contracts'

/** L'état de la session d'une tâche, tel que le journal le raconte. */
export interface BrowserSummary {
  taskId: string
  /** Vrai entre `browser.opened` et `browser.closed`. */
  open: boolean
  objective: string
  startUrl: string
  /** Échéance approuvée, ISO. */
  expiresAt: string | null
  /** Pourquoi la session est fermée, en français ; `null` tant qu'elle est ouverte. */
  closedReason: string | null
  /** Adresse après la dernière action, d'après le résumé de l'outil. */
  lastUrl: string | null
  /** Séquence de l'ouverture de la session : une nouvelle session en a une autre. */
  openedSeq: number
  /** Actions faites dans la session, captures comprises. */
  actions: number
  /**
   * Séquence du dernier événement après lequel la capture a pu changer : un
   * effet qui en dépend redemande l'image, et seulement alors.
   */
  frameSeq: number
}

/**
 * Les motifs de fermeture, écrits pour le modèle en anglais, dits à
 * l'utilisateur. Un motif inconnu s'affiche tel quel : mieux vaut de l'anglais
 * qu'un motif inventé.
 */
const CLOSED: Record<string, string> = {
  'cut by the human operator': 'coupée par vous',
  'its approved duration is over': 'la durée approuvée est écoulée',
  'closed by the agent': 'fermée par l\'agent',
  'the task ended': 'la tâche est finie',
  'the harness stopped': 'le daemon s\'est arrêté',
}

/** Le motif d'une fermeture, en français. */
export function closedReasonText(reason: string): string {
  return CLOSED[reason] ?? reason
}

/**
 * Résume la **dernière** session de navigateur d'une tâche.
 *
 * @returns `null` si la tâche n'a jamais ouvert de navigateur
 */
export function browserSummary(taskId: string, events: readonly TaskEvent[] | undefined): BrowserSummary | null {
  // Annoté par `as` : sans lui, l'analyse de flux réduit la variable à `null`
  // dans la boucle, et refuse ensuite de l'étaler.
  let summary = null as BrowserSummary | null
  // `tool.completed` ne porte pas le nom de l'outil : il se lit dans le
  // `tool.requested` du même appel.
  const names = new Map<string, string>()
  for (const e of events ?? []) {
    const p = e.payload
    if (e.type === 'tool.requested') names.set(String(p.tool_call_id), String(p.name))
    if (e.type === 'browser.opened') {
      summary = {
        taskId,
        open: true,
        objective: String(p.objective ?? ''),
        startUrl: String(p.start_url ?? ''),
        expiresAt: typeof p.expires_at === 'string' ? p.expires_at : null,
        closedReason: null,
        lastUrl: null,
        actions: 0,
        openedSeq: e.seq,
        frameSeq: e.seq,
      }
    } else if (summary && e.type === 'browser.closed') {
      summary = { ...summary, open: false, closedReason: closedReasonText(String(p.reason ?? '')), frameSeq: e.seq }
    } else if (summary && e.type === 'tool.completed' && names.get(String(p.tool_call_id))?.startsWith('browser_')) {
      // Le résumé d'une action est « action → adresse » (outils, `browser.ts`).
      const url = typeof p.summary === 'string' ? /→ (\S+)$/.exec(p.summary)?.[1] ?? null : null
      summary = {
        ...summary,
        actions: summary.actions + (p.status === 'succeeded' ? 1 : 0),
        lastUrl: url ?? summary.lastUrl,
        frameSeq: e.seq,
      }
    }
  }
  return summary
}
