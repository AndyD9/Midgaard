/**
 * @file Le dossier d'une tâche sur la VM Windows (Slice 9, étape 5.3b) : où il
 * vit, et le seul endroit où Midgaard s'autorise à effacer.
 *
 * Le dossier est `<dossier personnel du compte>/midgaard/tasks/<tâche>`, la
 * copie du worktree dans `work`. Le dossier personnel est celui que le SFTP
 * rend pour `.` : aucune supposition sur `C:\`, et le compte n'a pas besoin
 * d'écrire à la racine du disque.
 *
 * Ce module ne fait que calculer des chemins : il ne parle à aucun hôte. C'est
 * la session (`connection.ts`) qui crée, recopie et efface — et qui refuse
 * d'effacer hors de {@link RemoteTaskDir.base}, comme le harness ne supprime
 * rien hors de `worktreesDir` sur la machine de l'utilisateur.
 */
import { posix } from 'node:path'
import { RemoteError } from './connection.ts'

/**
 * Identifiant de tâche accepté dans un chemin distant : un UUID, la forme que
 * donne le daemon (`randomUUID`). Jamais de `..`, de séparateur ni de lettre
 * de lecteur : le chemin formé ne peut pas sortir de `tasks/`.
 */
export const REMOTE_TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Les chemins d'une tâche sur la VM, séparateur `/`, forme du SFTP. */
export interface RemoteTaskDir {
  /** `<home>/midgaard` : rien n'est jamais effacé hors de lui. */
  base: string
  /** `<home>/midgaard/tasks` : un dossier par tâche. */
  tasks: string
  /** `<home>/midgaard/tasks/<tâche>` : effacé à la fin de la tâche. */
  dir: string
  /** `<home>/midgaard/tasks/<tâche>/work` : la copie du worktree, refaite avant chaque commande. */
  work: string
}

/**
 * Les chemins d'une tâche sous un dossier personnel distant.
 *
 * @param home    le dossier personnel du compte, tel que le rend
 *                `RemoteSession.homeDir` (`/C:/Users/analyste`)
 * @param taskId  l'identifiant de la tâche, un UUID
 * @throws {RemoteError} `protocol` si l'identifiant n'est pas un UUID, ou si
 *         le dossier personnel n'est pas un chemin absolu
 */
export function remoteTaskDir(home: string, taskId: string): RemoteTaskDir {
  if (!REMOTE_TASK_ID_PATTERN.test(taskId)) {
    throw new RemoteError('protocol', `not a task id: ${JSON.stringify(taskId)}`)
  }
  if (!home.startsWith('/')) throw new RemoteError('protocol', `the remote home is not an absolute path: ${home}`)
  const base = posix.join(posix.normalize(home), 'midgaard')
  const tasks = posix.join(base, 'tasks')
  const dir = posix.join(tasks, taskId)
  return { base, tasks, dir, work: posix.join(dir, 'work') }
}

/**
 * Vrai si `path` est **strictement** sous `root`, une fois les deux normalisés
 * (séparateur `/`). `root` lui-même n'est pas sous `root` : effacer la racine
 * permise effacerait le travail de toutes les tâches.
 *
 * La comparaison ignore la casse : Windows ne distingue pas `Midgaard` de
 * `midgaard`, et un chemin écrit autrement désigne le même dossier.
 */
export function isStrictlyUnder(path: string, root: string): boolean {
  const p = posix.normalize(path).replace(/\/+$/, '').toLowerCase()
  const r = posix.normalize(root).replace(/\/+$/, '').toLowerCase()
  return p.startsWith(`${r}/`) && p.length > r.length + 1
}
