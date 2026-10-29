/**
 * @file Ce qu'est un outil, et sous quelle politique il s'exécute.
 *
 * Un outil porte **trois** choses, et la troisième est celle qui compte :
 * son schéma (ce qu'il accepte), son exécution (ce qu'il fait), et sa
 * **politique** (ce que le harness en pense avant de le laisser faire).
 *
 * La politique est évaluée sur les arguments **réels**, pas sur le nom de
 * l'outil. « `http_fetch` est autorisé » ne veut rien dire : c'est
 * `http_fetch("https://169.254.169.254/latest/meta-data/")` qu'il faut refuser,
 * et `http_fetch("https://docs.python.org/")` qu'il faut laisser passer.
 */
import type { z } from 'zod'
import type { ToolDecision, ToolResult } from '@midgaard/contracts'

/** Ce que le harness fait d'un hôte absent de la liste blanche. */
export const HTTP_POLICIES = ['open', 'approval', 'allowlist'] as const
export type HttpPolicy = (typeof HTTP_POLICIES)[number]

/** Ce qu'un outil reçoit du harness à chaque appel. */
export interface ToolContext {
  /**
   * Racine de lecture : le dossier du projet d'où la tâche a été déléguée.
   *
   * **Ce n'est pas une frontière de privilège** — le daemon tourne sous le
   * compte de l'utilisateur et pourrait lire ailleurs. C'est une frontière
   * d'intention : elle empêche un agent qui dérape ou un contenu web qui le
   * manipule d'aller fouiller `~/.ssh`. Le README du daemon le dit sans détour,
   * et l'interface aussi.
   */
  root: string
  /** Politique appliquée aux hôtes absents de {@link ToolContext.allowHosts}. */
  httpPolicy: HttpPolicy
  /** Hôtes explicitement autorisés. Motifs `example.com` ou `*.example.org`. */
  allowHosts: readonly string[]
  /**
   * Vrai seulement si {@link ToolContext.root} est le **worktree** de la tâche.
   *
   * Absent ou faux, tout outil d'écriture refuse — sans demander d'approbation :
   * écrire hors d'un worktree n'est pas négociable (PLAN §5). Le défaut est donc
   * la fermeture, et un contexte construit sans y penser ne peut rien écrire.
   */
  writable?: boolean | undefined
  /**
   * Le worktree de la tâche, pour les outils qui interrogent Git. `root` peut
   * en être un sous-dossier (monorepo ouvert sur `packages/api`) ; `path` est
   * la racine du worktree lui-même.
   */
  workspace?: { path: string; baseCommit: string } | null | undefined
  /** Annulation de la tâche : coupe les lectures et les requêtes en cours. */
  signal?: AbortSignal | undefined
  log: (...a: unknown[]) => void
}

/**
 * Un outil exposé à un agent.
 *
 * `schema` sert deux fois : à engendrer le JSON Schema envoyé au modèle, et à
 * valider ce qu'il renvoie. Une seule définition, donc aucune chance que les
 * deux divergent — et c'est la divergence qui produit les pannes qu'on ne
 * reproduit pas.
 */
export interface Tool<T = unknown> {
  name: string
  /** Description lue par le modèle : en anglais, et précise sur ce qui est refusé. */
  description: string
  schema: z.ZodType<T>
  /**
   * Décide du sort d'un appel **avant** de l'exécuter.
   *
   * @returns `allow` pour exécuter, `approval` pour suspendre la tâche jusqu'à
   *          décision humaine, `deny` pour refuser sans demander
   */
  policy(args: T, ctx: ToolContext): { decision: ToolDecision; reason: string }
  /** Exécute l'appel. @throws en cas d'échec ; la boucle en fait un résultat d'erreur */
  run(args: T, ctx: ToolContext): Promise<ToolResult>
}

/** Erreur d'outil destinée au modèle : lisible, actionnable, sans détail interne. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolError'
  }
}

/**
 * Taille maximale d'un résultat d'outil rendu au modèle.
 *
 * Un fichier de cinq mégaoctets réinjecté dans la conversation coûte plus cher
 * que toute la tâche, et sature la fenêtre de contexte au premier appel. La
 * troncature est **annoncée** dans le contenu : un agent qui ne sait pas qu'il
 * lit un extrait tire des conclusions fausses d'une absence.
 */
export const MAX_TOOL_RESULT_BYTES = 60_000

/** Tronque un contenu en le disant. */
export function truncate(content: string, max = MAX_TOOL_RESULT_BYTES): { text: string; bytes: number } {
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes <= max) return { text: content, bytes }
  // Découpe sur les octets, pas sur les caractères : c'est la taille en octets
  // qui est bornée. `toString` recolle proprement un caractère coupé en deux.
  const kept = Buffer.from(content, 'utf8').subarray(0, max).toString('utf8')
  return {
    text: `${kept}\n\n[…tronqué : ${bytes} octets au total, ${max} rendus]`,
    bytes,
  }
}
