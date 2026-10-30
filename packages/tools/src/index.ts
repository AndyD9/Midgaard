/**
 * @file Point d'entrée de `@midgaard/tools` : la boîte à outils, et la
 * traduction des schémas Zod en JSON Schema pour les fournisseurs.
 *
 * Le paquet ne connaît ni le daemon, ni la base, ni les fournisseurs. Il reçoit
 * un {@link ToolContext} et rend des {@link ToolResult}. C'est ce qui permet de
 * le tester seul — et les tests de sécurité du plan (§8.4) en dépendent.
 */
import { z } from 'zod'
import type { Tool, ToolContext } from './types.ts'
import { httpFetchTool } from './http.ts'
import { listDirectoryTool, readFileTool, searchFilesTool } from './fs.ts'
import { submitResultTool } from './result.ts'
import { deleteFileTool, editFileTool, writeFileTool } from './write.ts'
import { gitDiffTool } from './git.ts'
import { execTool } from './exec.ts'

export type { Tool, ToolContext, HttpPolicy, PreparedOperation } from './types.ts'
export { ToolError, HTTP_POLICIES, MAX_TOOL_RESULT_BYTES, truncate } from './types.ts'
export { canonicalRoot, isUnder, openUnderRoot, resolveUnderRoot } from './paths.ts'
export { assertPublicHost, hostAllowed, isPrivateAddress, IMDS_ADDRESS } from './net.ts'
export { follow, htmlToText } from './http.ts'
export type { HostGuard } from './http.ts'
export { checkWritePath, openForWrite, MAX_WRITE_BYTES } from './write.ts'
export {
  candidateNames, execAllowed, execEnv, formatArgv, parseExecAllow, resolveCommand, runCommand,
  EXEC_DEFAULT_TIMEOUT_S, EXEC_MAX_TIMEOUT_S, EXEC_KILL_GRACE_MS,
} from './exec.ts'
export type { ExecOutcome } from './exec.ts'
export { submitResultSchema } from './result.ts'
export type { SubmitResultArgs } from './result.ts'

/** Nom de l'outil terminal, que la boucle intercepte. */
export const SUBMIT_RESULT = 'submit_result'

/**
 * Tous les outils. Ceux de la Slice 2 lisent ; ceux de la Slice 3 écrivent dans
 * le worktree de la tâche et refusent partout ailleurs (`ToolContext.writable`).
 *
 * `web_search` n'y figure pas, et c'est délibéré : voir
 * {@link WEB_SEARCH_IS_NOT_A_TOOL}.
 */
export const TOOLBOX: Readonly<Record<string, Tool<never>>> = Object.freeze({
  read_file: readFileTool as Tool<never>,
  list_directory: listDirectoryTool as Tool<never>,
  search_files: searchFilesTool as Tool<never>,
  http_fetch: httpFetchTool as Tool<never>,
  write_file: writeFileTool as Tool<never>,
  edit_file: editFileTool as Tool<never>,
  delete_file: deleteFileTool as Tool<never>,
  git_diff: gitDiffTool as Tool<never>,
  exec: execTool as Tool<never>,
  submit_result: submitResultTool as Tool<never>,
})

/**
 * Pourquoi `web_search` n'est pas un outil appelable.
 *
 * Chez Venice, la recherche web n'est pas une fonction que le modèle appelle :
 * c'est un **drapeau de requête** (`venice_parameters.enable_web_search`), et le
 * modèle décide lui-même de chercher pendant qu'il répond. En faire un outil
 * exigerait un appel de modèle **supplémentaire** par recherche, donc de payer
 * deux fois ce que le fournisseur fait en une.
 *
 * Il reste donc dans la liste d'outils d'un profil — où il agit comme
 * l'interrupteur qui active la recherche native — sans jamais être proposé au
 * modèle. Et pour qu'il ne disparaisse pas de la vue, la boucle journalise un
 * appel `web_search` **a posteriori** dès que des citations reviennent, avec ses
 * sources et son coût. Observable, compté, attribué : seul le mécanisme change.
 */
export const WEB_SEARCH_IS_NOT_A_TOOL = 'web_search'

/** Récupère un outil par son nom. @returns `undefined` si l'outil n'existe pas */
export function findTool(name: string): Tool<never> | undefined {
  return TOOLBOX[name]
}

/** Description d'un outil pour un fournisseur : nom, description, JSON Schema. */
export interface ToolSpecLike {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/**
 * Traduit les outils d'un profil en descriptions envoyables à un modèle.
 *
 * Le JSON Schema est **engendré depuis le schéma Zod**, jamais écrit à côté :
 * une seule définition décrit l'outil au modèle et valide ce qu'il renvoie.
 * Deux définitions finiraient par diverger, et la divergence se verrait en
 * production plutôt qu'en test.
 *
 * `io: 'input'` compte : sans lui, un champ avec valeur par défaut est décrit
 * comme obligatoire, et le modèle croit devoir le remplir à chaque appel.
 *
 * @param names noms d'outils du profil ; ceux qui n'existent pas sont ignorés
 *              en silence — un profil qui mentionne un outil retiré ne doit pas
 *              empêcher la tâche de démarrer
 */
export function toolSpecs(names: readonly string[]): ToolSpecLike[] {
  const out: ToolSpecLike[] = []
  for (const name of names) {
    const tool = TOOLBOX[name]
    if (!tool) continue
    out.push({
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.schema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>,
    })
  }
  return out
}

/** Construit un contexte d'outils. */
export function toolContext(input: ToolContext): ToolContext {
  return input
}
