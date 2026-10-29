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
    `Project root (the only directory you can read): ${input.root}`,
    'Paths you pass to tools may be relative to that root. Anything outside it is refused.',
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
