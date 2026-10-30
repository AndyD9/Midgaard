/**
 * @file Profils d'agents exécutants : qui exécute, avec quel modèle, quels
 * outils et quelles limites.
 *
 * Un profil répond à trois questions, et les limites sont la troisième **parce
 * qu'elles sont une propriété du profil, pas une option de l'appel**. Si Claude
 * pouvait fixer le budget à chaque délégation, le budget ne protégerait plus
 * personne : il suffirait d'un modèle mal luné pour demander mille dollars. Une
 * délégation peut seulement **abaisser** les limites de son profil, jamais les
 * relever — voir {@link tightenLimits}.
 *
 * Le profil `simulated` de la Slice 1 est conservé : il fait tourner la machine
 * à états, les approbations et l'attente bloquante sans appeler le moindre
 * modèle, donc sans dépenser un centime. C'est le seul moyen d'exercer le
 * harness lui-même en intégration continue.
 */
import { z } from 'zod'

/**
 * Profils livrés. `developer` (Slice 3) est le seul qui écrit — dans un
 * worktree Git créé pour la tâche, jamais dans le dépôt de l'utilisateur.
 */
export const AGENT_KINDS = ['simulated', 'researcher', 'developer'] as const
export type AgentKind = (typeof AGENT_KINDS)[number]

/** Identifiant du profil simulé, réservé : aucun fournisseur, aucun coût. */
export const SIMULATED_AGENT_ID = 'simulated'

/**
 * Limites d'exécution. Chacune arrête la tâche **avant** l'appel qui les
 * dépasserait, jamais après : une limite constatée après coup a déjà été payée.
 */
export const agentLimitsSchema = z.object({
  /** Itérations de boucle, donc appels modèle au maximum. Garde-fou contre une boucle d'outils sans fin. */
  max_steps: z.number().int().min(1).max(100),
  /** Budget en dollars. Dépassement = statut `budget_exceeded`, pas `failed` : rien n'a échoué. */
  max_cost_usd: z.number().min(0).max(1000),
  /** Durée totale de la tâche, approbations comprises. */
  timeout_s: z.number().int().min(5).max(3600),
  /** Jetons de sortie par appel, transmis au fournisseur. Borne le coût d'une seule réponse. */
  max_output_tokens: z.number().int().min(64).max(200_000),
  /** Appels d'outils par itération. Les fournisseurs savent en demander plusieurs à la fois. */
  max_tool_calls_per_step: z.number().int().min(1).max(20),
})
export type AgentLimits = z.infer<typeof agentLimitsSchema>

/**
 * Limites par défaut d'un Researcher.
 *
 * Volontairement basses. Une première exécution qui coûte deux centimes et
 * s'arrête trop tôt s'ajuste ; une première exécution qui coûte vingt dollars ne
 * se rattrape pas. L'utilisateur relève ce qu'il veut, en connaissance de cause.
 */
export const DEFAULT_RESEARCHER_LIMITS: AgentLimits = Object.freeze({
  max_steps: 12,
  max_cost_usd: 0.5,
  timeout_s: 300,
  max_output_tokens: 4096,
  max_tool_calls_per_step: 5,
})

/**
 * Limites par défaut d'un Developer.
 *
 * Plus larges que celles du Researcher, pour trois raisons mesurables : écrire
 * du code demande de lire, modifier puis vérifier (plus d'étapes) ; le contenu
 * d'un `write_file` est payé en jetons de **sortie** (plafond par réponse plus
 * haut) ; et chaque `exec` peut attendre une approbation humaine jusqu'à dix
 * minutes, que le délai total compte. Elles restent un plafond que
 * l'utilisateur relève en connaissance de cause.
 */
export const DEFAULT_DEVELOPER_LIMITS: AgentLimits = Object.freeze({
  max_steps: 30,
  max_cost_usd: 1,
  timeout_s: 1800,
  max_output_tokens: 8192,
  max_tool_calls_per_step: 5,
})

/** Un profil d'agent, tel que le daemon le stocke et l'expose à Claude. */
export const agentSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/, 'minuscules, chiffres, tiret ou souligné'),
  name: z.string().min(1).max(200),
  kind: z.enum(AGENT_KINDS),
  /** Ce que l'agent sait faire, en une phrase. C'est ce que Claude lit pour choisir. */
  description: z.string().max(500),
  /** Fournisseur employé ; `null` pour `simulated`, qui n'appelle aucun modèle. */
  provider_id: z.string().nullable(),
  /** Modèle employé ; `null` = celui par défaut du fournisseur. */
  model: z.string().nullable(),
  /** Consigne système du profil. Le contexte de la tâche vient de Claude, pas d'ici. */
  system_prompt: z.string(),
  /** Outils autorisés, par nom. Tout outil absent de cette liste est refusé, approbation ou pas. */
  tools: z.array(z.string()),
  limits: agentLimitsSchema,
  /** Un profil désactivé reste visible et consultable, mais refuse les délégations. */
  enabled: z.boolean(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
})
export type Agent = z.infer<typeof agentSchema>

/**
 * Limites effectives d'une délégation : celles du profil, abaissées par celles
 * que Claude demande.
 *
 * **Jamais relevées.** C'est l'invariant du budget : le profil est le plafond,
 * l'appel ne peut que serrer. Une demande plus large n'est pas une erreur — elle
 * est simplement sans effet, et l'interface montre la limite réellement
 * appliquée.
 *
 * @param base    limites du profil
 * @param asked   limites demandées à la délégation ; chaque champ est facultatif
 * @returns les limites à appliquer
 *
 * @example
 * tightenLimits({ max_cost_usd: 0.5, ... }, { max_cost_usd: 5 }).max_cost_usd // 0.5
 * tightenLimits({ max_cost_usd: 0.5, ... }, { max_cost_usd: 0.1 }).max_cost_usd // 0.1
 */
export function tightenLimits(base: AgentLimits, asked: Partial<AgentLimits> = {}): AgentLimits {
  const floor = (a: number, b: number | undefined) => (b === undefined ? a : Math.min(a, b))
  return {
    max_steps: floor(base.max_steps, asked.max_steps),
    max_cost_usd: floor(base.max_cost_usd, asked.max_cost_usd),
    timeout_s: floor(base.timeout_s, asked.timeout_s),
    max_output_tokens: floor(base.max_output_tokens, asked.max_output_tokens),
    max_tool_calls_per_step: floor(base.max_tool_calls_per_step, asked.max_tool_calls_per_step),
  }
}

/** Limites qu'une délégation peut demander. Toutes facultatives, toutes abaissantes. */
export const requestedLimitsSchema = agentLimitsSchema.partial()
export type RequestedLimits = z.infer<typeof requestedLimitsSchema>
