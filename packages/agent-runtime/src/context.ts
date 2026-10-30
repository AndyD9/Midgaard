/**
 * @file Assemblage du contexte initial d'un agent.
 *
 * Le plan (§4) fixe la règle et sa raison : « c'est Claude Code qui fournit
 * `context`. Le runtime y ajoute seulement l'arborescence du workspace et les
 * consignes du profil. **L'agent ne refait pas l'exploration du dépôt — sinon le
 * coût explose et la délégation ne sert à rien.** »
 *
 * C'est le cœur économique du produit. Un agent qui commence par lire trente
 * fichiers pour comprendre où il est dépense plus que la question ne valait, et
 * déléguer devient plus cher que faire soi-même. Claude a déjà exploré ; ce
 * qu'il sait est transmis.
 *
 * L'arborescence est la seule exception, et elle est bornée : sans elle, l'agent
 * ne sait pas quels chemins existent et gaspille des appels à tâtonner.
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Agent, AgentLimits } from '@midgaard/contracts'
import type { Message } from '@midgaard/providers'

/** Dossiers écartés de l'arborescence : beaucoup d'entrées, aucune information. */
const SKIP = new Set(['node_modules', '.git', 'dist', '.next', 'build', '.venv', '__pycache__', 'coverage'])
/** Profondeur de l'arborescence. Deux niveaux situent un projet sans le décrire. */
const TREE_DEPTH = 2
/** Entrées au maximum. Au-delà, l'arborescence coûte plus qu'elle n'oriente. */
const MAX_TREE_ENTRIES = 200

/**
 * Dresse une arborescence courte du projet.
 *
 * @returns les lignes de l'arborescence, ou un message si le dossier est illisible
 */
export async function workspaceTree(root: string): Promise<string> {
  const lines: string[] = []
  let truncated = false

  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    if (depth > TREE_DEPTH || truncated) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue
      if (lines.length >= MAX_TREE_ENTRIES) {
        truncated = true
        return
      }
      if (entry.isDirectory()) {
        lines.push(`${prefix}${entry.name}/`)
        await walk(join(dir, entry.name), `${prefix}  `, depth + 1)
      } else if (entry.isFile()) {
        lines.push(`${prefix}${entry.name}`)
      }
    }
  }

  await walk(root, '', 1)
  if (lines.length === 0) return '(project root is empty or unreadable)'
  return lines.join('\n') + (truncated ? `\n[…truncated at ${MAX_TREE_ENTRIES} entries]` : '')
}

/**
 * Ce qu'un agent écrivant doit savoir de son worktree, et qu'il ne peut pas
 * deviner : où il est, d'où il part, et ce qui **manque**.
 */
export interface WorkspaceBrief {
  branch: string
  baseCommit: string
  /** Chemins non commités du dépôt d'origine — absents du worktree. */
  baseDirty: number
  /** Sous-modules vides dans le worktree, relatifs à la racine de l'agent. */
  submodules: readonly string[]
  /** Dossier d'origine, tel que Claude le cite dans son contexte. */
  originDir: string
}

/** Ce qu'il faut pour composer le premier tour de conversation. */
export interface ContextInput {
  agent: Agent
  objective: string
  /** Contexte fourni par Claude à la délégation. */
  context: string | null
  root: string
  tree: string
  limits: AgentLimits
  /** Vrai si le budget en dollars est réellement applicable. */
  budgetEnforceable: boolean
  /** Le worktree, pour un agent écrivant ; absent pour un agent qui ne fait que lire. */
  workspace?: WorkspaceBrief | undefined
}

/**
 * Compose les deux premiers messages : la consigne système, et la demande.
 *
 * **Les limites sont dites au modèle.** Elles seront appliquées par le code de
 * toute façon, mais un agent qui ignore qu'il n'a que douze étapes les dépense
 * à explorer, puis se fait couper sans avoir rien rendu. Lui dire son budget
 * change sa stratégie, pas seulement son information.
 *
 * Et quand le budget n'est **pas** applicable — tarif du modèle inconnu — on le
 * dit aussi, plutôt que d'annoncer un plafond qui n'opère pas.
 */
export function buildMessages(input: ContextInput): Message[] {
  const { limits } = input
  const budgetLine = input.budgetEnforceable
    ? `- Budget: ${limits.max_cost_usd} USD. The task stops when it is reached, even mid-work.`
    : '- Budget: this model has no known price, so the USD budget cannot be enforced. ' +
      'The step limit is what bounds this task.'

  const system = [
    input.agent.system_prompt,
    '',
    'Operating limits, enforced by the harness:',
    `- At most ${limits.max_steps} model steps. Each reply you make, with or without tool calls, is one step.`,
    budgetLine,
    `- ${limits.timeout_s} seconds wall clock in total, human approvals included.`,
    `- At most ${limits.max_tool_calls_per_step} tool calls per step.`,
    '',
    ...(input.workspace ? workspaceLines(input.root, input.workspace) : [
      `Project root (the only directory you can read): ${input.root}`,
      'Paths you pass to tools may be relative to that root. Anything outside it is refused.',
    ]),
  ].join('\n')

  const parts = [`# Task\n\n${input.objective}`]
  if (input.context?.trim()) {
    parts.push(
      '# Context from the orchestrator\n\n' +
        'This was assembled by Claude Code, which already explored the repository. ' +
        'Trust it and build on it; do not re-derive it.\n\n' +
        input.context.trim(),
    )
  }
  parts.push(`# Project tree (depth ${TREE_DEPTH})\n\n\`\`\`\n${input.tree}\n\`\`\``)
  parts.push('Begin. When you have the answer, call submit_result.')

  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n\n') },
  ]
}

/**
 * Ce que la consigne dit du worktree. Trois pièges y sont nommés, parce que
 * chacun coûte des étapes s'il est découvert en tâtonnant :
 *
 *  - Claude cite les chemins **du dépôt d'origine** ; l'agent doit les lire
 *    comme relatifs, sans quoi chaque appel est refusé « hors du workspace » ;
 *  - le travail non commité de l'utilisateur **n'est pas là** ;
 *  - les sous-modules sont des **dossiers vides**, où rien ne s'écrit ;
 *  - rien de ce que fait l'agent n'atteint le dépôt sans un merge humain — ce
 *    qui l'autorise à travailler franchement, et lui interdit de prétendre
 *    avoir livré.
 */
function workspaceLines(root: string, w: WorkspaceBrief): string[] {
  const lines = [
    `Workspace root (a git worktree of the project; the only directory you can read and write): ${root}`,
    `It is on branch ${w.branch}, created for this task from commit ${w.baseCommit.slice(0, 12)}.`,
    'Paths you pass to tools should be relative to that root. Anything outside it is refused.',
    `The orchestrator's context may cite absolute paths in the original repository (${w.originDir}): ` +
      'the same files are at the same relative paths in your workspace. Use relative paths.',
    'Nothing you do reaches the user\'s repository until a human reviews the diff and merges the branch. ' +
      'The harness commits your work when you call submit_result; do not try to commit yourself.',
  ]
  if (w.baseDirty > 0) {
    lines.push(
      `WARNING: the user had ${w.baseDirty} uncommitted change(s) in the original repository. They are NOT ` +
        'in your workspace, which starts from the last commit. If the context describes code you cannot find, ' +
        'this is why: say so in your result rather than guessing.',
    )
  }
  if (w.submodules.length > 0) {
    lines.push(
      `WARNING: these git submodules are EMPTY directories in your workspace: ${w.submodules.join(', ')}. ` +
        'Their code is not available to read, and you cannot write inside them. If the task depends on them, ' +
        'say so in your result rather than guessing.',
    )
  }
  return lines
}
