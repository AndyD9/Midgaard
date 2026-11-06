/**
 * @file Contrats des playbooks (Slice 9) : du savoir métier, écrit par un
 * humain, que le daemon ajoute à la consigne d'un profil.
 *
 * Un playbook est un fichier Markdown du dossier `playbooks/` du clone
 * Midgaard (décision 1 de docs/SLICE9.md). Ce fichier ne lit rien sur le
 * disque — `contracts` n'a aucun effet de bord — : il fixe la forme d'un
 * identifiant, les bornes de taille et ce que l'API rend. La lecture est
 * dans `packages/daemon/src/playbooks.ts`.
 */
import { z } from 'zod'

/**
 * Forme d'un identifiant de playbook : le nom du fichier sans `.md`.
 *
 * Minuscules, chiffres et tirets seulement. Ce n'est pas qu'une question de
 * goût : l'identifiant devient un chemin (`<dossier>/<id>.md`), et une forme
 * sans `/`, sans `.` ni `\` ne peut désigner aucun fichier hors du dossier.
 * Elle écarte aussi d'office `README.md`, qui documente le dossier pour les
 * humains et n'est pas un playbook.
 */
export const PLAYBOOK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/

/**
 * Taille maximale d'un playbook, en octets. Il est relu à **chaque** appel de
 * modèle de la tâche, donc payé à chaque appel : 32 Kio, c'est environ
 * 8 000 jetons — déjà le prix de plusieurs pages de documentation.
 */
export const PLAYBOOK_MAX_BYTES = 32 * 1024

/** Somme maximale des playbooks d'un profil, en octets (décision 5). */
export const PLAYBOOKS_MAX_BYTES_PER_AGENT = 96 * 1024

/** Nombre maximal de playbooks attachés à un profil. */
export const PLAYBOOKS_MAX_PER_AGENT = 8

/** Un playbook disponible, tel que `GET /api/playbooks` le décrit. */
export const playbookSummarySchema = z.object({
  id: z.string().regex(PLAYBOOK_ID_PATTERN),
  /** Le premier titre `# …` du fichier, ou l'identifiant s'il n'en a pas. */
  title: z.string(),
  bytes: z.number().int().min(0),
  /** SHA-256 du contenu, en hexadécimal : ce que la timeline d'une tâche cite. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /**
   * Pourquoi il ne peut pas être attaché (trop gros, pas de l'UTF-8) ;
   * `null` s'il le peut. Un fichier refusé reste listé : sinon l'humain qui
   * l'a écrit ne saurait pas pourquoi il n'apparaît pas.
   */
  unusable_reason: z.string().nullable(),
})
export type PlaybookSummary = z.infer<typeof playbookSummarySchema>

/** Réponse de `GET /api/playbooks`. */
export const playbooksResponseSchema = z.object({
  /** Le dossier lu, pour que l'humain sache quel fichier modifier. */
  dir: z.string(),
  playbooks: z.array(playbookSummarySchema),
})
export type PlaybooksResponse = z.infer<typeof playbooksResponseSchema>

/**
 * Corps de `PUT /api/agents/:id/playbooks` : la liste **complète** des
 * playbooks d'un profil, dans l'ordre où ils seront ajoutés à la consigne.
 * Une route à part, comme celle des serveurs MCP : ses règles n'ont rien à
 * voir avec celles du modèle ou des limites.
 */
export const setAgentPlaybooksRequestSchema = z.object({
  playbooks: z.array(z.string().regex(PLAYBOOK_ID_PATTERN)).max(PLAYBOOKS_MAX_PER_AGENT),
})
export type SetAgentPlaybooksRequest = z.infer<typeof setAgentPlaybooksRequestSchema>
