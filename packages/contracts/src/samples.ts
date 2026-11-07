/**
 * @file Échantillons d'analyse d'une tâche (Slice 9, étape 4).
 *
 * Un échantillon est un fichier qu'on **analyse sans jamais l'exécuter** : un
 * binaire PE, un script suspect, un document piégé. Celui qui délègue la tâche
 * le désigne ; le daemon en fait une **copie en lecture seule**, sous le
 * dossier runtime, et l'agent ne travaille que sur elle. L'outil `exec` refuse
 * de la lancer, de la faire lancer par un interpréteur ou un chargeur, ou d'en
 * lancer une copie identique (`packages/tools/src/exec.ts`).
 *
 * Ce module ne porte que les formes et les bornes : la copie et la
 * vérification sont dans `packages/daemon/src/samples.ts`.
 */
import { z } from 'zod'

/** Nombre maximal d'échantillons d'une tâche. */
export const SAMPLES_MAX_PER_TASK = 16
/**
 * Taille maximale d'un échantillon. Un installeur peut peser lourd ; au-delà,
 * la copie et l'empreinte revérifiée à chaque départ coûtent plus qu'elles ne
 * servent.
 */
export const SAMPLE_MAX_BYTES = 256 * 1024 * 1024
/** Somme maximale des échantillons d'une tâche. */
export const SAMPLES_MAX_BYTES_PER_TASK = 1024 * 1024 * 1024

/** Nom d'un échantillon dans le dossier de sa tâche : sans séparateur, sans point en tête. */
export const SAMPLE_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/

/** Un échantillon d'une tâche, tel que le daemon l'a copié. */
export const taskSampleSchema = z.object({
  /** Nom de la copie dans le dossier de la tâche ; c'est par lui qu'un orchestrateur le transmet. */
  name: z.string().regex(SAMPLE_NAME_PATTERN),
  /** SHA-256 de la copie, revérifié au départ de la tâche. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().min(0),
})
export type TaskSample = z.infer<typeof taskSampleSchema>

/**
 * Nom sûr pour la copie d'un fichier : son nom de base, chaque caractère hors
 * de `[A-Za-z0-9._-]` remplacé par `_`, pas de point en tête (fichier caché),
 * et un suffixe `-2`, `-3`… si le nom est déjà pris dans la tâche.
 *
 * @param base  nom de base du fichier source
 * @param taken noms déjà attribués dans la tâche, comparés sans casse (macOS
 *              et Windows ne distinguent pas `A.exe` de `a.exe`)
 */
export function sampleNameFor(base: string, taken: readonly string[]): string {
  let name = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[.-]+/, '').slice(0, 100) || 'sample'
  if (!/^[A-Za-z0-9_]/.test(name)) name = `_${name}`
  const used = new Set(taken.map((t) => t.toLowerCase()))
  if (!used.has(name.toLowerCase())) return name
  const dot = name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
}
