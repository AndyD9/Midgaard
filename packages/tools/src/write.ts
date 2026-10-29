/**
 * @file Outils d'écriture : `write_file`, `edit_file`, `delete_file`.
 *
 * Ils n'existent que pour un agent qui a un **worktree** : le contexte porte
 * alors `writable: true`, et sa racine est le worktree. Partout ailleurs — le
 * Researcher, ou un profil mal configuré qui aurait reçu ces outils par erreur —
 * la politique **refuse**, sans demander : PLAN §5, « écriture uniquement dans
 * le worktree assigné, jamais ailleurs, approbation ou pas ». C'est la seconde
 * serrure ; la première est la liste d'outils du profil.
 *
 * ## Ce que la résolution de chemin vérifie, et pourquoi
 *
 * Écrire est plus délicat que lire, parce que la cible n'existe souvent pas
 * encore : `realpath` ne peut pas la canonicaliser. {@link openForWrite} vérifie
 * donc, dans l'ordre :
 *
 *  1. le chemin **lexical** reste sous la racine (`../` refusé d'emblée) ;
 *  2. aucun segment ne s'appelle `.git` — dans un worktree, `.git` est un
 *     fichier qui dit à Git où est le dépôt : le réécrire redirigerait chaque
 *     commande du harness vers un autre dépôt, celui de l'utilisateur compris ;
 *  3. le plus proche **dossier existant** a un chemin réel sous la racine —
 *     c'est ce qui arrête un dossier-lien qui mène dehors ;
 *  4. la cible, si elle existe, n'est **pas un lien symbolique** : on n'écrit
 *     jamais à travers un lien, même s'il pointe sous la racine — un lien se
 *     redirige plus facilement qu'il ne se vérifie ;
 *  5. après ouverture (`O_NOFOLLOW`), le descripteur désigne bien un fichier
 *     ordinaire, et le dossier parent a gardé son identité (`dev`/`ino`) et son
 *     chemin réel. C'est l'invariant du dépôt : **revérifier à l'ouverture**,
 *     pas seulement avant.
 *
 * Le fichier est ouvert **sans** `O_TRUNC`, et vidé seulement une fois les
 * vérifications passées : un refus après ouverture ne doit pas avoir détruit le
 * contenu de ce qu'il refuse.
 */
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, stat, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { ToolResult } from '@midgaard/contracts'
import { isUnder } from './paths.ts'
import { ToolError, type Tool, type ToolContext } from './types.ts'

/**
 * Taille maximale d'un contenu écrit en un appel. Un agent qui produit un
 * fichier de plusieurs mégaoctets en un seul appel de modèle fabrique presque
 * toujours une donnée, pas du code — et la paie en jetons de sortie.
 */
export const MAX_WRITE_BYTES = 1024 * 1024

/**
 * `O_NOFOLLOW` n'existe pas sous Windows, où `constants.O_NOFOLLOW` vaut
 * `undefined`. On retombe alors sur le `lstat` de l'étape 4 seul — c'est dit
 * ici plutôt que supposé couvert.
 */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0

/** Politique commune : écrire suppose un worktree, et rien d'autre ne le remplace. */
function writePolicy(ctx: ToolContext): { decision: 'allow' | 'deny'; reason: string } {
  return ctx.writable
    ? { decision: 'allow', reason: 'écriture dans le worktree de la tâche, réversible' }
    : { decision: 'deny', reason: 'this agent has no workspace: it cannot write anything' }
}

/** Chemin relatif à la racine, séparateur `/`, pour les messages et le journal. */
function shown(root: string, path: string): string {
  return relative(root, path).split(sep).join('/') || '.'
}

/**
 * Vérifie un chemin d'écriture **sans rien ouvrir** : étapes 1 à 3 de l'en-tête.
 *
 * @returns le chemin cible (dont le dossier parent existe ou sera créé sous la
 *          racine) et le dossier existant le plus proche, canonicalisé
 * @throws {ToolError} sur échappée, segment `.git` ou dossier-lien sortant
 */
export async function checkWritePath(root: string, given: string): Promise<{ target: string; anchor: string }> {
  const target = isAbsolute(given) ? resolve(given) : resolve(root, given)
  if (target === root || !isUnder(root, target)) {
    throw new ToolError(`path is outside your workspace: ${given}. Use a path relative to the workspace root.`)
  }
  const segments = relative(root, target).split(sep)
  // Insensible à la casse : `.GIT` désigne le même fichier sur les systèmes de
  // fichiers par défaut de macOS et de Windows.
  if (segments.some((s) => s.toLowerCase() === '.git')) {
    throw new ToolError(`writing under .git is not allowed: ${given}`)
  }

  let anchor = dirname(target)
  while (!(await exists(anchor))) anchor = dirname(anchor)
  let realAnchor: string
  try {
    realAnchor = await realpath(anchor)
  } catch {
    // Un lien cassé sur le chemin : il ne mène nulle part de vérifiable.
    throw new ToolError(`path goes through a broken symbolic link: ${given}`)
  }
  if (!(await stat(realAnchor)).isDirectory()) {
    throw new ToolError(`a parent of this path is a file, not a directory: ${given}`)
  }
  if (!isUnder(root, realAnchor)) {
    // Comme en lecture : on ne dit pas où mène le lien.
    throw new ToolError(`path escapes your workspace through a symbolic link: ${given}`)
  }
  // Le dossier existant le plus proche est réel et sous la racine ; ce qui
  // reste à créer sous lui le sera par `mkdir`, qui ne suit aucun lien qu'il
  // crée lui-même. La cible est recomposée sur le chemin réel.
  return { target: join(realAnchor, relative(anchor, target)), anchor: realAnchor }
}

/** Vrai si quelque chose existe à ce chemin, lien cassé compris. */
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Ouvre un fichier en lecture-écriture sous la racine, selon les cinq étapes de
 * l'en-tête. L'appelant **doit** fermer le descripteur.
 *
 * @param create créer le fichier (et ses dossiers) s'il n'existe pas ; sinon,
 *               son absence est une erreur
 * @throws {ToolError} à chaque refus, avec une phrase que le modèle peut suivre
 */
export async function openForWrite(
  root: string,
  given: string,
  create: boolean,
): Promise<{ handle: FileHandle; path: string; existed: boolean }> {
  const { target } = await checkWritePath(root, given)
  const parent = dirname(target)

  let existed = false
  try {
    const st = await lstat(target)
    existed = true
    if (st.isSymbolicLink()) throw new ToolError(`refusing to write through a symbolic link: ${given}`)
    if (!st.isFile()) throw new ToolError(`not a regular file: ${given}`)
  } catch (e) {
    if (e instanceof ToolError) throw e
    if (!create) throw new ToolError(`no such file: ${given}. Create it with write_file.`)
  }

  if (!existed) {
    await mkdir(parent, { recursive: true }).catch((e: Error) => {
      throw new ToolError(`cannot create the directories of ${given}: ${e.message}`)
    })
  }
  // Le parent vient d'être créé ou existait : il doit encore être réel et sous
  // la racine. Son identité est relevée pour être comparée après ouverture.
  const realParent = await realpath(parent)
  if (realParent !== parent || !isUnder(root, realParent)) {
    throw new ToolError(`path changed while preparing to write it: ${given}`)
  }
  const parentBefore = await stat(realParent)

  let handle: FileHandle
  try {
    handle = await open(join(realParent, basename(target)), constants.O_RDWR | constants.O_CREAT | NOFOLLOW, 0o644)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    // ELOOP : la cible est devenue un lien entre le `lstat` et l'ouverture.
    if (code === 'ELOOP') throw new ToolError(`refusing to write through a symbolic link: ${given}`)
    if (code === 'EISDIR') throw new ToolError(`is a directory: ${given}`)
    throw new ToolError(`cannot open ${given} for writing: ${(e as Error).message}`)
  }
  try {
    const st = await handle.stat()
    if (!st.isFile()) throw new ToolError(`not a regular file: ${given}`)
    const parentAfter = await stat(realParent)
    if (
      parentAfter.ino !== parentBefore.ino ||
      parentAfter.dev !== parentBefore.dev ||
      (await realpath(realParent)) !== realParent
    ) {
      throw new ToolError(`path changed while opening it: ${given}`)
    }
    return { handle, path: join(realParent, basename(target)), existed }
  } catch (e) {
    await handle.close().catch(() => {})
    throw e
  }
}

/** Remplace tout le contenu d'un descripteur ouvert par {@link openForWrite}. */
async function replaceContent(handle: FileHandle, content: string): Promise<number> {
  const buffer = Buffer.from(content, 'utf8')
  await handle.truncate(0)
  await handle.write(buffer, 0, buffer.length, 0)
  return buffer.length
}

// --- write_file --------------------------------------------------------------

const writeSchema = z.object({
  path: z.string().min(1).describe('File path, relative to your workspace root'),
  content: z
    .string()
    .refine((c) => Buffer.byteLength(c, 'utf8') <= MAX_WRITE_BYTES, `content must be at most ${MAX_WRITE_BYTES} bytes`)
    .describe('The complete new content of the file'),
})

/** Crée ou remplace un fichier du worktree. */
export const writeFileTool: Tool<z.infer<typeof writeSchema>> = {
  name: 'write_file',
  description:
    'Create a file, or replace its whole content, in your workspace (a git worktree of the project). ' +
    'Parent directories are created. Prefer edit_file to change part of an existing file. ' +
    'Refused: paths outside the workspace, anything under .git, and writing through symbolic links.',
  schema: writeSchema,
  policy: (_args, ctx) => writePolicy(ctx),

  async run(args, ctx): Promise<ToolResult> {
    const { handle, path, existed } = await openForWrite(ctx.root, args.path, true)
    try {
      const bytes = await replaceContent(handle, args.content)
      const rel = shown(ctx.root, path)
      return {
        content: `${existed ? 'Replaced' : 'Created'} ${rel} (${bytes} bytes).`,
        bytes,
        summary: `${rel} ${existed ? 'remplacé' : 'créé'} · ${bytes} octets`,
        untrusted: false,
      }
    } finally {
      await handle.close().catch(() => {})
    }
  },
}

// --- edit_file ---------------------------------------------------------------

const editSchema = z.object({
  path: z.string().min(1).describe('File path, relative to your workspace root'),
  old_string: z.string().min(1).describe('Exact text to replace, including whitespace and indentation'),
  new_string: z.string().describe('Replacement text'),
  replace_all: z
    .boolean()
    .default(false)
    .describe('Replace every occurrence. Without it, old_string must occur exactly once.'),
})

/** Remplace un passage exact d'un fichier du worktree. */
export const editFileTool: Tool<z.infer<typeof editSchema>> = {
  name: 'edit_file',
  description:
    'Replace an exact passage of an existing file in your workspace. old_string must match the file exactly ' +
    'and occur once, unless replace_all is true. Read the file first: guessing its content wastes steps.',
  schema: editSchema,
  policy: (_args, ctx) => writePolicy(ctx),

  async run(args, ctx): Promise<ToolResult> {
    const { handle, path } = await openForWrite(ctx.root, args.path, false)
    try {
      const { size } = await handle.stat()
      if (size > MAX_WRITE_BYTES) throw new ToolError(`file too large to edit (${size} bytes): ${args.path}`)
      const buffer = Buffer.alloc(size)
      await handle.read(buffer, 0, size, 0)
      if (buffer.includes(0)) throw new ToolError(`not a text file: ${args.path}`)
      const before = buffer.toString('utf8')

      // `split` et non `replace` : `String.replace` interprète `$&` et `$1`
      // dans le texte de remplacement — un piège déjà payé ailleurs dans ce
      // dépôt (CLAUDE.md, « Pièges d'environnement »). Du code contient des `$`.
      const parts = before.split(args.old_string)
      const occurrences = parts.length - 1
      if (occurrences === 0) {
        throw new ToolError(`old_string not found in ${args.path}. Read the file and copy the passage exactly.`)
      }
      if (occurrences > 1 && !args.replace_all) {
        throw new ToolError(
          `old_string occurs ${occurrences} times in ${args.path}. Include more surrounding text to make it unique, ` +
            'or set replace_all.',
        )
      }
      const bytes = await replaceContent(handle, parts.join(args.new_string))
      const rel = shown(ctx.root, path)
      return {
        content: `Edited ${rel}: ${occurrences} replacement(s), now ${bytes} bytes.`,
        bytes,
        summary: `${rel} modifié · ${occurrences} remplacement(s)`,
        untrusted: false,
      }
    } finally {
      await handle.close().catch(() => {})
    }
  },
}

// --- delete_file -------------------------------------------------------------

const deleteSchema = z.object({
  path: z.string().min(1).describe('File path, relative to your workspace root'),
})

/** Supprime un fichier du worktree. */
export const deleteFileTool: Tool<z.infer<typeof deleteSchema>> = {
  name: 'delete_file',
  description:
    'Delete one file from your workspace. Directories are refused. The deletion shows in the diff and is ' +
    'reversible until a human merges the branch.',
  schema: deleteSchema,
  policy: (_args, ctx) => writePolicy(ctx),

  async run(args, ctx): Promise<ToolResult> {
    const { target } = await checkWritePath(ctx.root, args.path)
    let st
    try {
      st = await lstat(target)
    } catch {
      throw new ToolError(`no such file: ${args.path}`)
    }
    if (st.isDirectory()) throw new ToolError(`is a directory, and only files can be deleted: ${args.path}`)
    // Un lien symbolique est supprimé **lui-même** : `unlink` n'atteint jamais
    // sa cible. C'est donc sûr, même pour un lien qui mène hors de la racine.
    await unlink(target)
    const rel = shown(ctx.root, target)
    return { content: `Deleted ${rel}.`, bytes: 0, summary: `${rel} supprimé`, untrusted: false }
  },
}
