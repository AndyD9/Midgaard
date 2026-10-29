/**
 * @file Demandes d'approbation humaine.
 *
 * Une approbation est liée à **une opération précise** et à **une seule
 * utilisation** : jamais « autoriser toutes les commandes `npm` » (§5 du plan).
 * Elle expire au bout de `approvalTtlMs`, sinon une tâche oubliée resterait en
 * pause indéfiniment en retenant un worktree et un emplacement d'exécution.
 *
 * En Slice 1, l'opération est simulée (`operation` décrit l'étape factice). En
 * Slice 3, elle portera la commande, ses arguments et le chemin visé, avec leur
 * empreinte, pour qu'une décision ne puisse pas être rejouée sur autre chose.
 */
import { z } from 'zod'

/** Cycle de vie d'une demande : `pending` puis exactement un état final. */
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired'] as const
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]

export const approvalSchema = z.object({
  id: z.uuid(),
  task_id: z.uuid(),
  /** Numéro de la pause sur cette tâche : correspond à `task.approval_seq`. */
  seq: z.number().int().positive(),
  /** Description lisible par un humain de ce qu'il autorise. */
  operation: z.string(),
  /**
   * Empreinte de l'opération exacte. Une décision ne vaut que pour elle :
   * si l'opération change, l'empreinte change et l'approbation ne s'applique plus.
   */
  operation_hash: z.string(),
  status: z.enum(APPROVAL_STATUSES),
  requested_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  resolved_at: z.iso.datetime().nullable(),
  /** Qui a décidé : `cli` ou `dashboard`. Jamais le modèle. */
  resolved_by: z.string().nullable(),
  /** Motif facultatif d'un refus, transmis à la tâche. */
  reason: z.string().nullable(),
})
export type Approval = z.infer<typeof approvalSchema>
