/**
 * @file Lecture des worktrees pour l'API : le worktree d'une tâche, et son diff
 * calculé à la demande.
 *
 * Séparé du routeur parce que la CLI en aura besoin (`harness workspaces`,
 * Slice 3, étape 7) et qu'aucune logique de Git n'a sa place dans un routeur.
 *
 * Le diff n'est **jamais mis en cache**. Il se recalcule à chaque lecture contre
 * le commit de départ : un diff conservé serait vrai au moment de l'écrire, puis
 * faux sans le dire dès que l'agent écrit un fichier de plus — et c'est
 * précisément pendant que l'agent travaille qu'on le regarde.
 */
import { existsSync } from 'node:fs'
import type { TaskWorkspaceResponse } from '@midgaard/contracts'
import type { HarnessStore } from '@midgaard/persistence'
import { diffWorktree } from '@midgaard/workspace'

/**
 * Le worktree d'une tâche et son diff.
 *
 * Ne lève pas : chaque impossibilité devient une phrase dans `unavailable`,
 * qui dit **où retrouver le travail** quand il existe encore — la branche
 * survit au worktree.
 */
export async function workspaceView(store: HarnessStore, taskId: string): Promise<TaskWorkspaceResponse> {
  const workspace = store.workspaceForTask(taskId)
  if (!workspace) {
    return { workspace: null, diff: null, unavailable: 'cette tâche n\'a pas de worktree : son profil n\'écrit pas' }
  }
  const atBranch =
    `la branche ${workspace.branch} reste dans le dépôt : ` +
    `git diff ${workspace.base_commit.slice(0, 12)} ${workspace.branch}`
  if (workspace.status === 'removed') {
    return { workspace, diff: null, unavailable: `worktree retiré ; ${atBranch}` }
  }
  if (!existsSync(workspace.worktree_path)) {
    return { workspace, diff: null, unavailable: `le dossier du worktree a disparu (${workspace.worktree_path}) ; ${atBranch}` }
  }
  try {
    return { workspace, diff: await diffWorktree(workspace.worktree_path, workspace.base_commit), unavailable: null }
  } catch (e) {
    return { workspace, diff: null, unavailable: `diff impossible : ${(e as Error).message}` }
  }
}
