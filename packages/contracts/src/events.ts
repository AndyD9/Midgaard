/**
 * @file Journal d'événements : le récit append-only de ce qui est arrivé à chaque tâche.
 *
 * Deux numéros de séquence, parce qu'ils répondent à deux questions différentes :
 *  - `seq` est **global** et strictement croissant sur tout le journal. C'est lui
 *    que le dashboard renvoie après une coupure WebSocket (« j'en étais à 412 »)
 *    pour récupérer exactement ce qu'il a manqué. Sans un compteur global, une
 *    reconnexion laisserait un trou invisible dans la timeline ;
 *  - `task_seq` est **local à une tâche** et commence à 1. C'est l'ordre d'affichage
 *    d'une timeline de tâche, stable même si d'autres tâches tournent en parallèle.
 *
 * Les deux sont attribués par la base, dans la même transaction que la mise à jour
 * de la tâche : un événement ne peut donc pas décrire un état qui n'a pas été
 * persisté, ni l'inverse.
 */
import { z } from 'zod'
import { taskStatusSchema } from './task.ts'

/**
 * Types d'événements émis en Slice 1.
 *
 * Le vocabulaire suit le plan (§6). `agent.message` sert dès maintenant à la
 * narration des étapes simulées : le dashboard a ainsi quelque chose à montrer,
 * et le canal est déjà en place pour les vrais agents de la Slice 2.
 * `tool.requested|completed`, `artifact.created` et `usage.updated` arriveront
 * avec eux.
 */
export const EVENT_TYPES = [
  'task.created',
  'task.started',
  'task.progress',
  'task.completed',
  'task.failed',
  'task.cancelled',
  'task.interrupted',
  'agent.message',
  'approval.requested',
  'approval.resolved',
] as const
export type EventType = (typeof EVENT_TYPES)[number]

/** Une ligne du journal, telle qu'elle est persistée et diffusée. */
export const taskEventSchema = z.object({
  /** Séquence globale, strictement croissante, jamais réutilisée. Clé de la reprise WebSocket. */
  seq: z.number().int().positive(),
  /** Séquence locale à la tâche, à partir de 1. */
  task_seq: z.number().int().positive(),
  task_id: z.uuid(),
  type: z.enum(EVENT_TYPES),
  at: z.iso.datetime(),
  /** Statut de la tâche juste après l'événement : évite au dashboard de recouper. */
  status: taskStatusSchema,
  /** Charge utile propre au type d'événement. Toujours un objet, jamais `null`. */
  payload: z.record(z.string(), z.unknown()),
})
export type TaskEvent = z.infer<typeof taskEventSchema>

/** Événement avant persistance : la base attribue `seq`, `task_seq` et `at`. */
export type NewTaskEvent = Omit<TaskEvent, 'seq' | 'task_seq' | 'at'> & { at?: string }
