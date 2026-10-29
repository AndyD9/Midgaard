/**
 * @file Protocole entre le serveur MCP, la CLI, le dashboard et le daemon :
 * version, formes des réponses HTTP et messages WebSocket.
 */
import { z } from 'zod'
import { taskEventSchema } from './events.ts'
import { approvalSchema } from './approvals.ts'
import { NEXT_ACTIONS, taskSchema } from './task.ts'

/**
 * Version du protocole, annoncée par `GET /api/health`.
 *
 * Le daemon survit aux mises à jour du code : un serveur MCP récent peut tomber
 * sur un daemon ancien dont il ne comprend plus les réponses. Celui qui trouve une
 * autre version arrête le daemon et en démarre un neuf.
 *
 * **À incrémenter à tout changement incompatible** de l'API HTTP, du modèle de
 * tâche ou du protocole WebSocket.
 *  - 1 : spike initial ;
 *  - 2 : pauses d'approbation numérotées (`approval_seq`, `known_approval`) ;
 *  - 3 : Slice 1 — persistance SQLite, journal d'événements, WebSocket, routes
 *        préfixées `/api`, statuts `preparing`/`cancel_requested`/`interrupted`/
 *        `timed_out`/`budget_exceeded`.
 */
export const PROTOCOL_VERSION = 3

/** Contenu du fichier de découverte du daemon. **Secret** : il donne le contrôle du daemon. */
export const runtimeInfoSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().positive(),
  /** Jeton aléatoire de 256 bits, régénéré à chaque démarrage du daemon. */
  token: z.string().min(32),
  started_at: z.iso.datetime(),
  protocol: z.number().int().positive(),
  /** URL du dashboard, prête à être transmise à l'utilisateur. */
  dashboard_url: z.url(),
})
export type RuntimeInfo = z.infer<typeof runtimeInfoSchema>

/** Réponse de `GET /api/health`. */
export const healthSchema = z.object({
  ok: z.literal(true),
  pid: z.number().int(),
  protocol: z.number().int(),
  uptime_s: z.number().int(),
  port: z.number().int(),
  dashboard_url: z.url(),
  /**
   * Vrai si les fichiers du dashboard sont réellement servis. Sans cela, rien
   * ne doit renvoyer l'utilisateur vers cette URL : c'est la leçon du défaut
   * n° 1 de la Slice 0, où Claude a dirigé l'utilisateur vers un dashboard qui
   * n'existait pas encore.
   */
  dashboard_available: z.boolean(),
  tasks: z.object({ total: z.number().int(), active: z.number().int() }),
  /** Millisecondes restantes avant arrêt pour inactivité ; `null` si l'arrêt est désactivé. */
  idle_shutdown_in_ms: z.number().int().nullable(),
  db_path: z.string(),
})
export type Health = z.infer<typeof healthSchema>

/** Corps de `POST /api/tasks`. Les mêmes bornes sont revérifiées côté daemon. */
export const createTaskRequestSchema = z.object({
  objective: z.string().min(1).max(4000),
  duration_s: z.number().int().min(1).max(900).default(20),
  needs_approval: z.boolean().default(false),
})
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>

/** Réponse portant une tâche et la consigne associée. */
export const taskViewSchema = z.object({
  task: taskSchema,
  next_action: z.enum(NEXT_ACTIONS),
  /** Approbation en cours, s'il y en a une. */
  approval: approvalSchema.nullable().default(null),
})
export type TaskView = z.infer<typeof taskViewSchema>

/** Réponse de `GET /api/tasks/:id/wait`. */
export const waitResponseSchema = taskViewSchema.extend({
  waited_ms: z.number().int().min(0),
})
export type WaitResponse = z.infer<typeof waitResponseSchema>

// --- WebSocket -------------------------------------------------------------

/**
 * Sous-protocole WebSocket. Les navigateurs ne permettent pas de poser un
 * en-tête `Authorization` sur une connexion WebSocket : le jeton passe donc par
 * le sous-protocole, seul champ que l'API du navigateur laisse remplir.
 */
export const WS_SUBPROTOCOL = 'midgaard.v1'
/** Préfixe du second sous-protocole, qui porte le jeton : `midgaard-token.<jeton>`. */
export const WS_TOKEN_PREFIX = 'midgaard-token.'

/**
 * Messages envoyés par le daemon au dashboard.
 *
 * `snapshot` est toujours le premier : il porte l'état complet des tâches et les
 * événements manqués depuis le `since` demandé. `event` suit en temps réel.
 * Le client retient `seq` et le renvoie à la reconnexion — c'est ce qui garantit
 * qu'une coupure ne laisse pas de trou dans la timeline.
 */
export type ServerMessage =
  | {
      type: 'snapshot'
      /** Dernière séquence globale connue du serveur au moment du snapshot. */
      seq: number
      tasks: z.infer<typeof taskSchema>[]
      approvals: z.infer<typeof approvalSchema>[]
      /** Événements d'après le `since` demandé, dans l'ordre. Vide à la première connexion. */
      events: z.infer<typeof taskEventSchema>[]
      /** Vrai si `since` était trop ancien pour être rejoué : le client doit repartir du snapshot. */
      truncated: boolean
      health: Health
    }
  | { type: 'event'; event: z.infer<typeof taskEventSchema>; task: z.infer<typeof taskSchema> }
  | { type: 'approval'; approval: z.infer<typeof approvalSchema> }
  | { type: 'health'; health: Health }

/** Messages envoyés par le dashboard au daemon. Le ping sert à garder la connexion vivante. */
export type ClientMessage = { type: 'ping' }

/**
 * Nombre maximal d'événements rejoués lors d'une reprise. Au-delà, le serveur
 * répond `truncated: true` plutôt que de déverser tout le journal : le client
 * repart alors du snapshot, qui est de toute façon complet pour l'état courant.
 */
export const MAX_REPLAY_EVENTS = 2000
