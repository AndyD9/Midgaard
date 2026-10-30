/**
 * @file Espaces de travail : le worktree Git où un agent écrivant travaille.
 *
 * Un agent Developer n'écrit **jamais** dans le dépôt de l'utilisateur. Il
 * reçoit un worktree Git à lui, sur une branche à lui, partant du commit où se
 * trouvait le dépôt au moment de la délégation. Ce qu'il y fait est réversible
 * par construction : supprimer le worktree et la branche efface tout, et rien
 * n'arrive dans le dépôt de l'utilisateur sans un merge **humain** — le harness
 * ne merge jamais (décision de la Slice 3, PLAN §9.5).
 *
 * Cycle de vie d'un espace, volontairement court :
 *
 * ```text
 *   active ──(fin de tâche, ou redémarrage du daemon)──► kept ──(nettoyage)──► removed
 *     └───────────────────────(nettoyage forcé)────────────────────────────────┘
 * ```
 *
 * `kept` est l'état normal d'un espace dont la tâche est finie : il est
 * **conservé jusqu'à ce qu'un humain le nettoie** (PLAN §9.4). Rien n'est
 * supprimé automatiquement — un diff qu'on n'a pas encore lu ne doit pas
 * disparaître parce qu'une minuterie l'a décidé. La branche, elle, survit même
 * au nettoyage : c'est elle qui porte le travail.
 */
import { z } from 'zod'

/** États d'un espace de travail. Voir l'en-tête du module. */
export const WORKSPACE_STATUSES = ['active', 'kept', 'removed'] as const
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number]

/** Préfixe des branches créées par le harness. Un humain doit les reconnaître d'un coup d'œil. */
export const WORKSPACE_BRANCH_PREFIX = 'midgaard/'

export const workspaceSchema = z.object({
  id: z.uuid(),
  task_id: z.uuid(),
  /** Racine **canonique** du dépôt d'origine (sortie de `git rev-parse --show-toplevel`, puis `realpath`). */
  repo_dir: z.string(),
  /**
   * Sous-dossier du dépôt d'où la tâche a été déléguée, relatif à la racine,
   * avec `/` final ou vide. Un monorepo ouvert sur `packages/api` doit donner à
   * l'agent `packages/api` dans son worktree, pas la racine entière.
   */
  subdir: z.string(),
  /** Chemin du worktree, hors du dépôt (`~/.midgaard/worktrees/…`). */
  worktree_path: z.string(),
  /** Branche créée pour la tâche, toujours préfixée par {@link WORKSPACE_BRANCH_PREFIX}. */
  branch: z.string(),
  /** Commit de départ. Le diff se calcule toujours contre lui, jamais contre une branche qui a pu bouger. */
  base_commit: z.string(),
  /** Branche du dépôt d'origine au moment de la délégation ; `null` si HEAD était détaché. */
  base_ref: z.string().nullable(),
  /**
   * Nombre de chemins modifiés **non commités** dans le dépôt d'origine au moment
   * de la délégation. Ils ne sont **pas** dans le worktree, qui part du dernier
   * commit : un agent à qui l'on décrit du code non commité ne le trouvera pas.
   * Le chiffre est conservé pour que cet écart soit annoncé, pas découvert.
   */
  base_dirty: z.number().int().min(0),
  status: z.enum(WORKSPACE_STATUSES),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  removed_at: z.iso.datetime().nullable(),
})
export type Workspace = z.infer<typeof workspaceSchema>

/**
 * Ce que le résultat d'une tâche Developer dit de son worktree. C'est ce que
 * Claude reçoit : où est le travail, et sur quelle branche le merger — le
 * harness, lui, ne merge jamais.
 */
export const taskWorkspaceSchema = z.object({
  branch: z.string(),
  base_commit: z.string(),
  /** Commit fait par le harness à la fin de la tâche ; `null` si l'agent n'a rien changé. */
  commit: z.string().nullable(),
  worktree_path: z.string(),
  files_changed: z.number().int().min(0),
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
  /** Chemins non commités du dépôt d'origine, absents du worktree : voir {@link Workspace.base_dirty}. */
  base_dirty: z.number().int().min(0),
})
export type TaskWorkspace = z.infer<typeof taskWorkspaceSchema>

/**
 * Une commande que `exec` lance sans approbation dans les worktrees d'un dépôt.
 * Argv **exact** : rien de plus, rien de moins.
 */
export const execAllowEntrySchema = z.object({
  repo_dir: z.string(),
  argv: z.array(z.string()).min(1),
  added_at: z.iso.datetime(),
  added_by: z.string(),
})
export type ExecAllowEntry = z.infer<typeof execAllowEntrySchema>

/** Nature d'un changement de fichier, au sens de `git diff --name-status`. */
export const FILE_CHANGE_KINDS = ['added', 'modified', 'deleted', 'type_changed'] as const
export type FileChangeKind = (typeof FILE_CHANGE_KINDS)[number]

/** Un fichier touché par l'agent. */
export const fileChangeSchema = z.object({
  /** Chemin relatif à la racine du dépôt, séparateur `/`. */
  path: z.string(),
  kind: z.enum(FILE_CHANGE_KINDS),
  /** Lignes ajoutées ; `null` pour un fichier binaire, où la notion n'a pas de sens. */
  additions: z.number().int().min(0).nullable(),
  deletions: z.number().int().min(0).nullable(),
  binary: z.boolean(),
})
export type FileChange = z.infer<typeof fileChangeSchema>

/**
 * Ce qu'un agent a changé depuis {@link Workspace.base_commit} : ses commits,
 * ses modifications non commitées **et ses fichiers nouveaux**.
 *
 * Les fichiers nouveaux comptent : un `git diff` ordinaire les ignore, et un
 * diff qui oublie le fichier que l'agent vient de créer ment sur l'essentiel.
 */
export const workspaceDiffSchema = z.object({
  base_commit: z.string(),
  files: z.array(fileChangeSchema),
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
  /** Patch unifié, éventuellement tronqué — {@link WorkspaceDiff.patch_truncated} le dit. */
  patch: z.string(),
  /** Taille réelle du patch, en octets, avant troncature. */
  patch_bytes: z.number().int().min(0),
  patch_truncated: z.boolean(),
})
export type WorkspaceDiff = z.infer<typeof workspaceDiffSchema>
