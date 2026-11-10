/**
 * @file Un *finding* : une vulnérabilité candidate, suivie par le daemon dans
 * l'arbre d'un orchestrateur, de sa découverte à sa confirmation (Slice 10,
 * étape 2).
 *
 * C'est l'objet qui rend la **porte de traçage mécanique**. Un finding naît
 * `open` (étape `hunt`), peut être `rejected` (étape `validate`), et n'atteint
 * `trace_confirmed` que par un **acte** — l'outil `confirm_trace`, qui exige une
 * chaîne source→sink complète et le modèle de menace. Seuls les findings
 * `trace_confirmed` entrent dans le rapport : c'est le daemon qui le garantit,
 * pas la consigne d'un playbook. La même idée que « la fin d'une tâche est un
 * acte, pas une interprétation » (`submit_result`) : un modèle qui écrit « c'est
 * tracé » n'a pas tracé.
 *
 * Le finding appartient à **l'arbre** d'un orchestrateur (`tree_task_id` est la
 * tâche racine), comme un agent créé (Slice 8) : il n'existe que là, et un autre
 * arbre ne le voit pas.
 */
import { z } from 'zod'

/**
 * Cycle de vie d'un finding :
 *  - `open` : enregistré par `record_finding` (étape `hunt`), pas encore jugé ;
 *  - `rejected` : écarté par `reject_finding` (étape `validate`), avec un motif ;
 *  - `trace_confirmed` : chaîne attaquant→sink prouvée par `confirm_trace`
 *    (étape `trace`). **Le seul statut que le rapport accepte.**
 */
export const FINDING_STATUSES = ['open', 'rejected', 'trace_confirmed'] as const
export type FindingStatus = (typeof FINDING_STATUSES)[number]
export const findingStatusSchema = z.enum(FINDING_STATUSES)

/**
 * Un pas de la chaîne de contamination : une référence de code (`fichier:ligne`)
 * et ce qui s'y passe. La chaîne va de la source (entrée attaquant) au sink
 * (opération dangereuse) ; chaque pas est une affirmation vérifiable, jamais une
 * paraphrase.
 */
export const taintStepSchema = z.object({
  /** Référence de code, p. ex. `src/fmt/hdr.c:42`. */
  ref: z.string().trim().min(1).max(200),
  /** Ce qui arrive à la valeur contaminée à ce pas, en une phrase. */
  note: z.string().trim().min(1).max(1000),
})
export type TaintStep = z.infer<typeof taintStepSchema>

/**
 * Longueur minimale d'une chaîne confirmée : la source **et** le sink, au moins.
 * Exigée au bord de l'outil `confirm_trace` : une « confirmation » sans chaîne
 * est exactement ce que la porte doit refuser.
 */
export const MIN_TAINT_PATH = 2

/** Un finding, tel que le daemon le stocke et l'expose à l'orchestrateur. */
export const findingSchema = z.object({
  /** UUID v4, rendu par `record_finding`. */
  id: z.uuid(),
  /**
   * Tâche racine de l'arbre à laquelle ce finding appartient (l'orchestrateur).
   * **Posé par le daemon seul**, comme `parent_task_id` d'une tâche : un client
   * ne choisit pas l'arbre d'un finding.
   */
  tree_task_id: z.uuid(),
  /** Le bug en une ligne : classe, endroit, effet. */
  title: z.string(),
  /** Classe de vulnérabilité (overflow, UAF, injection, désérialisation…). */
  vuln_class: z.string(),
  /** L'opération dangereuse, `fichier:ligne`. */
  sink: z.string(),
  /** Où entre la valeur contrôlée par l'attaquant, `fichier:ligne` ou description. */
  source: z.string(),
  /** Le code lu qui étaye le finding ; cité, jamais paraphrasé. */
  evidence: z.string(),
  status: findingStatusSchema,
  /** Motif du rejet ; `null` tant que le finding n'est pas `rejected`. */
  reject_reason: z.string().nullable(),
  /** Modèle de menace retenu à la confirmation ; `null` avant. */
  threat_model: z.string().nullable(),
  /** La chaîne source→sink ; `[]` tant que le finding n'est pas `trace_confirmed`. */
  taint_path: z.array(taintStepSchema).default([]),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
})
export type Finding = z.infer<typeof findingSchema>
