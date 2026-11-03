/**
 * @file Les fichiers d'une tâche, **en lecture seule**, pour l'explorateur et
 * l'éditeur du dashboard (Slice 6, étape 5).
 *
 * Deux lectures, et aucune écriture :
 *  - **l'arbre** du worktree d'un Developer, ou du dossier de projet d'une
 *    tâche qui ne fait que lire ;
 *  - **un fichier**, dans sa version de travail ou au commit de départ, pour
 *    l'afficher et le comparer.
 *
 * Le chemin vient d'une requête HTTP : il est traité comme celui qu'écrit un
 * modèle, par les mêmes outils (`resolveUnderRoot`, `openUnderRoot` :
 * racine canonique, identité du descripteur revérifiée à l'ouverture). Trois
 * règles de plus, propres à cette route :
 *
 *  - **rien sous `.git`**, à aucun niveau, quelle que soit la casse — un
 *    système de fichiers insensible à la casse ouvre `.GIT/config` comme
 *    `.git/config`. Et la règle vaut pour le chemin **réel** aussi : un lien
 *    posé par l'agent dans son worktree (`x → .git/config`) reste sous la
 *    racine, et passerait sinon. Dans un worktree, `.git` est un fichier qui
 *    désigne le dépôt de l'utilisateur ;
 *  - **un lien symbolique se montre, ne se suit pas** dans l'arbre ;
 *  - **la version de départ se lit par `git cat-file blob`**, qui ne lance
 *    aucun filtre ni `textconv` désigné par l'arbre, et par `git()`, qui
 *    neutralise les hooks : l'arbre est écrit par l'agent.
 *
 * Une troisième lecture, depuis la Slice 7 : **une image** (`taskImage`), pour
 * montrer dans le fil celle qu'un agent a lue par `read_image`. Mêmes règles de
 * chemin, et celles de l'outil : le type se lit dans les octets (PNG, JPEG,
 * WebP, GIF — jamais un SVG, qui est du texte et peut porter un script), 4 Mo
 * au plus. Elle est lue **sur le disque, maintenant** : aucune image n'est
 * gardée en base, et son empreinte dit si c'est encore celle que l'agent a vue.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { FileContentResponse, FileTreeEntry, FileTreeResponse, Task, Workspace } from '@midgaard/contracts'
import type { HarnessStore } from '@midgaard/persistence'
import type { ImageMediaType } from '@midgaard/contracts'
import {
  canonicalRoot, MAX_IMAGE_BYTES, openUnderRoot, resolveUnderRoot, sniffImageType, toolPath, ToolError,
} from '@midgaard/tools'
import { git } from '@midgaard/workspace'

/** Entrées de l'arbre au plus. Au-delà, il est coupé, et la réponse le dit. */
export const MAX_TREE_ENTRIES = 5000
/** Fichier rendu au plus, en octets. Au-delà : `too_large`, sans contenu. */
export const MAX_FILE_BYTES = 1024 * 1024
/**
 * Dossiers listés **sans leur contenu** : des milliers d'entrées, aucune écrite
 * par l'agent. L'explorateur les montre repliés plutôt que de les cacher.
 */
const COLLAPSED = new Set(['node_modules', 'dist', 'build', '.next', 'coverage', '.venv', '__pycache__', 'target'])

/** Un refus de lecture, à traduire en code HTTP par la route. */
export class FileAccessError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'FileAccessError'
    this.status = status
    this.code = code
  }
}

/** Où lire les fichiers d'une tâche. */
interface FileSource {
  source: 'worktree' | 'project'
  root: string
  workspace: Workspace | null
}

/**
 * La racine des fichiers d'une tâche : son worktree s'il en a un, sinon son
 * dossier de projet.
 *
 * @returns la source, ou la phrase qui dit pourquoi il n'y en a pas
 */
async function sourceOf(store: HarnessStore, task: Task): Promise<FileSource | { unavailable: string }> {
  const workspace = store.workspaceForTask(task.id)
  if (workspace) {
    if (workspace.status === 'removed') {
      return { unavailable: `worktree retiré ; la branche ${workspace.branch} reste dans le dépôt` }
    }
    if (!existsSync(workspace.worktree_path)) {
      return { unavailable: `le dossier du worktree a disparu (${workspace.worktree_path})` }
    }
    return { source: 'worktree', root: await canonicalRoot(workspace.worktree_path), workspace }
  }
  if (!task.project_dir) return { unavailable: 'cette tâche ne lit aucun dossier' }
  if (!existsSync(task.project_dir)) return { unavailable: `le dossier du projet a disparu (${task.project_dir})` }
  return { source: 'project', root: await canonicalRoot(task.project_dir), workspace: null }
}

/** Vrai si un chemin relatif (séparateur `/`) passe par `.git`, quelle que soit la casse. */
function touchesGit(rel: string): boolean {
  return rel.split('/').some((part) => part.toLowerCase() === '.git')
}

/**
 * Vérifie un chemin demandé **avant** tout accès au disque : relatif, sans
 * `..`, sans `.git`. Les deux séparateurs sont lus comme `/` : un `\` passerait
 * sinon pour un caractère du nom sous POSIX et pour un séparateur sous Windows.
 *
 * @returns le chemin normalisé, séparateur `/`
 * @throws {FileAccessError} 400 si le chemin est refusé
 */
export function checkRequestedPath(given: string): string {
  const unified = given.replaceAll('\\', '/')
  if (!unified || unified.startsWith('/') || /^[a-zA-Z]:/.test(unified)) {
    throw new FileAccessError(400, 'path_refused', 'le chemin doit être relatif à la racine de la tâche')
  }
  const parts = unified.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.length === 0) throw new FileAccessError(400, 'path_refused', 'chemin vide')
  if (parts.includes('..')) throw new FileAccessError(400, 'path_refused', 'le chemin ne peut pas remonter (..)')
  const rel = parts.join('/')
  if (touchesGit(rel)) throw new FileAccessError(400, 'path_refused', 'rien ne se lit sous .git')
  return rel
}

/**
 * L'arbre des fichiers d'une tâche, sans `.git`, liens non suivis, dossiers de
 * dépendances repliés, coupé à {@link MAX_TREE_ENTRIES} entrées.
 */
export async function taskFileTree(store: HarnessStore, task: Task): Promise<FileTreeResponse> {
  const found = await sourceOf(store, task)
  if ('unavailable' in found) {
    return { source: null, root: null, entries: [], truncated: false, unavailable: found.unavailable }
  }
  const entries: FileTreeEntry[] = []
  let truncated = false

  const walk = async (dir: string): Promise<void> => {
    const listed = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of listed.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.toLowerCase() === '.git') continue
      if (entries.length >= MAX_TREE_ENTRIES) {
        truncated = true
        return
      }
      const full = join(dir, entry.name)
      const path = toolPath(found.root, full)
      // `withFileTypes` décrit l'entrée elle-même, sans suivre un lien : un
      // lien vers un dossier reste un lien, et l'arbre ne sort jamais de la racine.
      if (entry.isSymbolicLink()) {
        entries.push({ path, type: 'symlink', size: null, collapsed: false })
      } else if (entry.isDirectory()) {
        const collapsed = COLLAPSED.has(entry.name)
        entries.push({ path, type: 'dir', size: null, collapsed })
        if (!collapsed) await walk(full)
      } else if (entry.isFile()) {
        const size = await lstat(full).then((s) => s.size).catch(() => null)
        entries.push({ path, type: 'file', size, collapsed: false })
      }
    }
  }

  await walk(found.root)
  return { source: found.source, root: found.root, entries, truncated, unavailable: null }
}

/**
 * Un fichier d'une tâche, dans sa version de travail ou au commit de départ.
 *
 * @param given chemin demandé, relatif à la racine de la tâche
 * @param rev   `work` (le disque) ou `base` (le commit de départ du worktree)
 * @throws {FileAccessError} si le chemin est refusé, la tâche sans fichiers, ou
 *         `base` demandé pour une tâche sans worktree
 */
export async function taskFileContent(
  store: HarnessStore,
  task: Task,
  given: string,
  rev: 'work' | 'base',
): Promise<FileContentResponse> {
  const rel = checkRequestedPath(given)
  const found = await sourceOf(store, task)
  if ('unavailable' in found) throw new FileAccessError(409, 'files_unavailable', found.unavailable)
  const empty = { path: rel, rev, exists: false, size: null, binary: false, too_large: false, text: null }

  if (rev === 'base') {
    if (!found.workspace) {
      throw new FileAccessError(400, 'no_base', 'cette tâche n\'a pas de worktree, donc pas de commit de départ')
    }
    return readBase(found.root, found.workspace.base_commit, rel, empty)
  }

  // Absent du disque : un fichier que l'agent a supprimé, un côté vide du diff.
  try {
    await resolveUnderRoot(found.root, rel)
  } catch (e) {
    if (e instanceof ToolError && /^no such path/.test(e.message)) return empty
    throw refusal(e)
  }
  let opened: Awaited<ReturnType<typeof openUnderRoot>>
  try {
    opened = await openUnderRoot(found.root, rel)
  } catch (e) {
    throw refusal(e)
  }
  try {
    // Le chemin réel, après résolution des liens : un lien posé par l'agent
    // vers `.git/config` reste sous la racine, et serait sinon lu.
    if (touchesGit(toolPath(found.root, opened.path))) {
      throw new FileAccessError(400, 'path_refused', 'rien ne se lit sous .git')
    }
    if (opened.size > MAX_FILE_BYTES) return { ...empty, exists: true, size: opened.size, too_large: true }
    const buffer = Buffer.alloc(opened.size)
    const { bytesRead } = await opened.handle.read(buffer, 0, opened.size, 0)
    const raw = buffer.subarray(0, bytesRead)
    if (raw.includes(0)) return { ...empty, exists: true, size: opened.size, binary: true }
    return { ...empty, exists: true, size: opened.size, text: raw.toString('utf8') }
  } finally {
    await opened.handle.close().catch(() => {})
  }
}

/**
 * Lit une image de la tâche, sur le disque (Slice 7).
 *
 * @returns ses octets, son type lu dans les octets et son SHA-256 complet
 * @throws {FileAccessError} 400 pour un chemin refusé, 404 pour un fichier
 *         absent, 409 sans racine lisible, 413 au-delà de 4 Mo, 415 si ce
 *         n'est pas une image admise
 */
export async function taskImage(
  store: HarnessStore,
  task: Task,
  given: string,
): Promise<{ bytes: Buffer; mediaType: ImageMediaType; sha256: string }> {
  const rel = checkRequestedPath(given)
  const found = await sourceOf(store, task)
  if ('unavailable' in found) throw new FileAccessError(409, 'files_unavailable', found.unavailable)
  let opened: Awaited<ReturnType<typeof openUnderRoot>>
  try {
    opened = await openUnderRoot(found.root, rel)
  } catch (e) {
    if (e instanceof ToolError && /^no such path/.test(e.message)) {
      throw new FileAccessError(404, 'file_not_found', 'ce fichier n\'existe plus')
    }
    throw refusal(e)
  }
  try {
    if (touchesGit(toolPath(found.root, opened.path))) {
      throw new FileAccessError(400, 'path_refused', 'rien ne se lit sous .git')
    }
    if (opened.size > MAX_IMAGE_BYTES) {
      throw new FileAccessError(413, 'image_too_large', `image de ${opened.size} octets, plus que ${MAX_IMAGE_BYTES}`)
    }
    const buffer = Buffer.alloc(opened.size)
    const { bytesRead } = await opened.handle.read(buffer, 0, opened.size, 0)
    const bytes = buffer.subarray(0, bytesRead)
    const mediaType = sniffImageType(bytes)
    if (!mediaType) throw new FileAccessError(415, 'not_an_image', 'ni PNG, ni JPEG, ni WebP, ni GIF')
    return { bytes, mediaType, sha256: createHash('sha256').update(bytes).digest('hex') }
  } finally {
    await opened.handle.close().catch(() => {})
  }
}

/**
 * Lit un fichier au commit de départ, par `git cat-file`. Aucun filtre, aucun
 * `textconv`, aucun hook : ce que le dépôt contient, tel quel.
 */
async function readBase(
  root: string,
  baseCommit: string,
  rel: string,
  empty: FileContentResponse,
): Promise<FileContentResponse> {
  const spec = `${baseCommit}:${rel}`
  const sized = await git(['cat-file', '-s', spec], { cwd: root })
  // Absent du commit de départ : un fichier que l'agent a créé.
  if (sized.code !== 0) return empty
  const size = Number(sized.stdout.trim())
  if (!Number.isFinite(size)) return empty
  if (size > MAX_FILE_BYTES) return { ...empty, exists: true, size, too_large: true }
  const blob = await git(['cat-file', 'blob', spec], { cwd: root, maxOutputBytes: MAX_FILE_BYTES + 1 })
  if (blob.code !== 0) return empty
  if (blob.stdout.includes('\u0000')) return { ...empty, exists: true, size, binary: true }
  return { ...empty, exists: true, size, text: blob.stdout }
}

/**
 * Traduit un refus des outils de chemin en refus HTTP. Le message ne dit pas
 * où mène un lien : le dashboard n'a pas à apprendre l'arborescence de la machine.
 */
function refusal(e: unknown): FileAccessError {
  if (e instanceof FileAccessError) return e
  if (e instanceof ToolError) {
    if (/escapes the allowed project root/.test(e.message)) {
      return new FileAccessError(400, 'path_refused', 'le chemin sort de la racine de la tâche')
    }
    if (/not a regular file/.test(e.message)) return new FileAccessError(400, 'not_a_file', 'ce n\'est pas un fichier')
    if (/changed while opening/.test(e.message)) {
      return new FileAccessError(409, 'path_changed', 'le fichier a changé pendant son ouverture')
    }
    return new FileAccessError(400, 'path_refused', e.message)
  }
  return new FileAccessError(500, 'read_failed', (e as Error).message)
}
