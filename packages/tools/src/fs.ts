/**
 * @file Outils de lecture du projet : `read_file`, `list_directory`, `search_files`.
 *
 * Tous passent par {@link resolveUnderRoot} ou {@link openUnderRoot} : aucun ne
 * manipule un chemin fourni par un modèle sans l'avoir canonicalisé et vérifié.
 * Aucun n'écrit : l'écriture vit dans `write.ts`, et n'opère que dans un worktree.
 *
 * Trois dossiers sont ignorés d'office à la recherche et au listage :
 * `node_modules`, `.git` et `dist`. Ce n'est pas de la sécurité, c'est de
 * l'économie — ils représentent l'essentiel des fichiers d'un dépôt et aucun de
 * ses réponses. Les lister ferait payer au modèle des jetons pour du bruit.
 */
import { readdir, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { z } from 'zod'
import type { ToolResult } from '@midgaard/contracts'
import { openUnderRoot, resolveUnderRoot } from './paths.ts'
import { MAX_TOOL_RESULT_BYTES, ToolError, truncate, type Tool, type ToolContext } from './types.ts'

/** Dossiers écartés du listage et de la recherche : beaucoup de fichiers, aucune réponse. */
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', '.next', 'build', '.venv', '__pycache__'])

/** Entrées listées au maximum, pour qu'un dossier géant ne noie pas le contexte. */
const MAX_ENTRIES = 400
/** Résultats de recherche au maximum. */
const MAX_MATCHES = 80
/** Fichiers parcourus au maximum par une recherche. Borne le temps, pas seulement la sortie. */
const MAX_SCANNED_FILES = 4000

// --- read_file -------------------------------------------------------------

const readSchema = z.object({
  path: z.string().min(1).describe('File path, absolute or relative to the project root'),
})

/** Lit un fichier texte du projet. */
export const readFileTool: Tool<z.infer<typeof readSchema>> = {
  name: 'read_file',
  description:
    'Read one text file from the project. The path must stay inside the project root; ' +
    'symlinks pointing outside are refused. Large files are truncated, and the truncation is stated.',
  schema: readSchema,
  policy: () => ({ decision: 'allow', reason: 'lecture seule sous la racine du projet' }),

  async run(args, ctx): Promise<ToolResult> {
    const { handle, path, size } = await openUnderRoot(ctx.root, args.path)
    try {
      // On ne lit que ce qui sera rendu, plus une marge : charger cinquante
      // mégaoctets pour en rendre soixante kilo-octets serait absurde.
      const toRead = Math.min(size, MAX_TOOL_RESULT_BYTES + 1024)
      const buffer = Buffer.alloc(toRead)
      const { bytesRead } = await handle.read(buffer, 0, toRead, 0)
      const raw = buffer.subarray(0, bytesRead)
      // Un octet nul signe un binaire. Le rendre au modèle coûterait cher pour
      // du bruit, et masquerait la vraie raison de l'échec.
      if (raw.includes(0)) throw new ToolError(`not a text file: ${args.path}`)

      const { text } = truncate(raw.toString('utf8'))
      const shown = size > MAX_TOOL_RESULT_BYTES ? `${text}\n\n[…fichier de ${size} octets]` : text
      return {
        content: shown,
        bytes: size,
        summary: `${relative(ctx.root, path) || path} · ${size} octets`,
        // Le projet de l'utilisateur n'est pas plus suspect que le dépôt
        // lui-même : ce n'est pas du contenu venu du monde extérieur.
        untrusted: false,
      }
    } finally {
      await handle.close().catch(() => {})
    }
  },
}

// --- list_directory --------------------------------------------------------

const listSchema = z.object({
  path: z.string().default('.').describe('Directory path, relative to the project root'),
})

/** Liste le contenu d'un dossier du projet. */
export const listDirectoryTool: Tool<z.infer<typeof listSchema>> = {
  name: 'list_directory',
  description:
    'List the entries of one directory in the project. Dependency and build directories ' +
    '(node_modules, .git, dist…) are skipped. Does not recurse.',
  schema: listSchema,
  policy: () => ({ decision: 'allow', reason: 'lecture seule sous la racine du projet' }),

  async run(args, ctx): Promise<ToolResult> {
    const dir = await resolveUnderRoot(ctx.root, args.path)
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => {
      throw new ToolError(`not a directory: ${args.path}`)
    })

    const lines: string[] = []
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue
      if (lines.length >= MAX_ENTRIES) {
        lines.push(`[…${entries.length - lines.length} entrées supplémentaires]`)
        break
      }
      if (entry.isDirectory()) {
        lines.push(`${entry.name}/`)
      } else if (entry.isSymbolicLink()) {
        // Signalé comme tel : un lien peut mener hors de la racine, et sa
        // lecture sera alors refusée. Mieux vaut que le modèle le sache avant.
        lines.push(`${entry.name} (lien symbolique)`)
      } else {
        const size = await stat(join(dir, entry.name))
          .then((s) => `${s.size} o`)
          .catch(() => '?')
        lines.push(`${entry.name}  ${size}`)
      }
    }

    const shown = relative(ctx.root, dir) || '.'
    return {
      content: lines.length ? lines.join('\n') : '(dossier vide)',
      bytes: Buffer.byteLength(lines.join('\n')),
      summary: `${shown} · ${lines.length} entrée(s)`,
      untrusted: false,
    }
  },
}

// --- search_files ----------------------------------------------------------

const searchSchema = z.object({
  pattern: z.string().min(1).describe('Regular expression to search for, JavaScript syntax'),
  path: z
    .string()
    .default('.')
    .describe(
      'Directory to search in, relative to the project root. Must be a directory, not a file: ' +
        'to search inside one file, pass its directory and narrow with glob, or read it with read_file.',
    ),
  glob: z
    .string()
    .optional()
    .describe('Optional file name suffix filter, for example ".ts" or ".md"'),
})

/** Cherche un motif dans les fichiers du projet. */
export const searchFilesTool: Tool<z.infer<typeof searchSchema>> = {
  name: 'search_files',
  description:
    'Search the project for a regular expression and return matching lines with their file and line number. ' +
    'Dependency and build directories are skipped, and results are capped.',
  schema: searchSchema,
  policy: () => ({ decision: 'allow', reason: 'lecture seule sous la racine du projet' }),

  async run(args, ctx): Promise<ToolResult> {
    let regex: RegExp
    try {
      // Pas de drapeau `g` : il rend `test` et `exec` dépendants d'un état
      // interne, et on veut juger chaque ligne indépendamment.
      regex = new RegExp(args.pattern, 'i')
    } catch (e) {
      throw new ToolError(`invalid regular expression: ${(e as Error).message}`)
    }

    const root = await resolveUnderRoot(ctx.root, args.path)

    // `walk` tolère un dossier illisible : une recherche ne doit pas mourir
    // parce qu'un dossier parmi mille refuse le listage. À la **racine** de la
    // recherche, cette même tolérance rendait un chiffre faux — `readdir` lève
    // `ENOTDIR` sur un fichier, le `catch` l'avalait, et le modèle recevait
    // « 0 correspondance » au lieu d'une erreur. Un faux négatif est pire qu'un
    // refus : il a l'air d'une réponse, et le modèle le croit. Mesuré en vraie
    // session — l'agent a cherché un symbole qui existait, l'a cru absent, et y
    // a laissé son budget d'étapes (docs/SLICE2.md, § défaut n° 1).
    //
    // Ce `stat` n'est pas un contrôle de sécurité : `resolveUnderRoot` a déjà
    // vérifié la racine, et chaque fichier parcouru est rouvert sous contrôle par
    // `openUnderRoot`. Il ne sert qu'à refuser proprement plutôt qu'à mentir.
    if (!(await stat(root)).isDirectory()) {
      const parent = dirname(args.path) || '.'
      throw new ToolError(
        `search_files searches a directory, and "${args.path}" is not one. ` +
          `Search "${parent}" instead and narrow with glob, or read the file with read_file.`,
      )
    }

    const matches: string[] = []
    let scanned = 0
    let capped = false

    const walk = async (dir: string): Promise<void> => {
      if (capped || ctx.signal?.aborted) return
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (capped) return
        if (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
          continue
        }
        // Les liens symboliques ne sont pas suivis : ils peuvent sortir de la
        // racine, et une boucle de liens ferait tourner la recherche sans fin.
        if (!entry.isFile()) continue
        if (args.glob && !entry.name.endsWith(args.glob)) continue
        if (++scanned > MAX_SCANNED_FILES) {
          capped = true
          return
        }
        await scan(full)
      }
    }

    const scan = async (file: string): Promise<void> => {
      const { handle, size } = await openUnderRoot(ctx.root, file).catch(() => ({ handle: null, size: 0 }))
      if (!handle) return
      try {
        if (size > 2 * 1024 * 1024) return
        const buffer = Buffer.alloc(Math.min(size, 2 * 1024 * 1024))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        const raw = buffer.subarray(0, bytesRead)
        if (raw.includes(0)) return
        const lines = raw.toString('utf8').split('\n')
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!
          if (!regex.test(line)) continue
          matches.push(`${relative(ctx.root, file)}:${i + 1}: ${line.trim().slice(0, 300)}`)
          if (matches.length >= MAX_MATCHES) {
            capped = true
            return
          }
        }
      } finally {
        await handle.close().catch(() => {})
      }
    }

    await walk(root)

    const body = matches.length ? matches.join('\n') : '(aucune correspondance)'
    const note = capped ? `\n\n[…arrêté à ${matches.length} correspondance(s) ou ${scanned} fichier(s)]` : ''
    return {
      content: body + note,
      bytes: Buffer.byteLength(body),
      summary: `${matches.length} correspondance(s) dans ${scanned} fichier(s)`,
      untrusted: false,
    }
  },
}
