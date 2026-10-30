/**
 * @file Protocole entre le serveur MCP, la CLI, le dashboard et le daemon :
 * version, formes des réponses HTTP et messages WebSocket.
 */
import { z } from 'zod'
import { taskEventSchema } from './events.ts'
import { approvalSchema } from './approvals.ts'
import { NEXT_ACTIONS, taskSchema, taskStatusSchema } from './task.ts'
import { agentSchema, requestedLimitsSchema } from './agent.ts'
import { connectionTestSchema, PROVIDER_PRESETS, providerConfigSchema, WEB_SEARCH_MODES } from './provider.ts'
import { pricingTableSchema } from './usage.ts'
import { toolCallSchema } from './tools.ts'
import { execAllowEntrySchema, workspaceDiffSchema, workspaceSchema } from './workspace.ts'

/**
 * Version du protocole, annoncée par `GET /api/health`.
 *
 * Le daemon survit aux mises à jour du code : un serveur MCP récent peut tomber
 * sur un daemon ancien dont il ne comprend plus les réponses. Celui qui trouve une
 * autre version arrête le daemon et en démarre un neuf.
 *
 * **À incrémenter à tout changement incompatible** de l'API HTTP, du modèle de
 * tâche ou du protocole WebSocket.
 *  - 1 : spike initial ;
 *  - 2 : pauses d'approbation numérotées (`approval_seq`, `known_approval`) ;
 *  - 3 : Slice 1 — persistance SQLite, journal d'événements, WebSocket, routes
 *        préfixées `/api`, statuts `preparing`/`cancel_requested`/`interrupted`/
 *        `timed_out`/`budget_exceeded` ;
 *  - 4 : Slice 2 — agents réels. La tâche porte `agent_id`, `context`, `limits`
 *        et `usage` ; le journal gagne `tool.*`, `usage.updated` et
 *        `task.budget_exceeded` ; les routes `/api/agents` et `/api/providers`
 *        apparaissent. Un daemon de protocole 3 ne sait rien de tout cela, et
 *        rendrait des tâches sans coût ni agent : il doit être remplacé ;
 *  - 5 : Slice 3, premier pas — le journal gagne `workspace.created`,
 *        `workspace.kept` et `workspace.removed`. Un daemon de protocole 4
 *        n'écrirait pas ces événements, et le dashboard servi par un daemon
 *        récent les attend ;
 *  - 6 : Slice 3, étape 4 — une approbation porte `operation_detail`, l'opération
 *        exacte sous forme structurée, et son empreinte en est tirée. Un daemon
 *        de protocole 5 rendrait des approbations sans ce champ, que le
 *        dashboard et le serveur MCP valident désormais ;
 *  - 7 : Slice 3, étape 5 — le profil `developer` (nouveau `kind`) et le
 *        résultat de tâche gagne `workspace` (branche, commit, ampleur).
 */
export const PROTOCOL_VERSION = 7

/** Contenu du fichier de découverte du daemon. **Secret** : il donne le contrôle du daemon. */
export const runtimeInfoSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().positive(),
  /** Jeton aléatoire de 256 bits, régénéré à chaque démarrage du daemon. */
  token: z.string().min(32),
  started_at: z.iso.datetime(),
  protocol: z.number().int().positive(),
  /** URL du dashboard, prête à être transmise à l'utilisateur. */
  dashboard_url: z.url(),
})
export type RuntimeInfo = z.infer<typeof runtimeInfoSchema>

/** Réponse de `GET /api/health`. */
export const healthSchema = z.object({
  ok: z.literal(true),
  pid: z.number().int(),
  protocol: z.number().int(),
  uptime_s: z.number().int(),
  port: z.number().int(),
  dashboard_url: z.url(),
  /**
   * Vrai si les fichiers du dashboard sont réellement servis. Sans cela, rien
   * ne doit renvoyer l'utilisateur vers cette URL : c'est la leçon du défaut
   * n° 1 de la Slice 0, où Claude a dirigé l'utilisateur vers un dashboard qui
   * n'existait pas encore.
   */
  dashboard_available: z.boolean(),
  tasks: z.object({ total: z.number().int(), active: z.number().int() }),
  /** Millisecondes restantes avant arrêt pour inactivité ; `null` si l'arrêt est désactivé. */
  idle_shutdown_in_ms: z.number().int().nullable(),
  db_path: z.string(),
})
export type Health = z.infer<typeof healthSchema>

/**
 * Corps de `POST /api/tasks`. Les mêmes bornes sont revérifiées côté daemon.
 *
 * `duration_s` et `needs_approval` ne concernent que le profil `simulated` ; un
 * agent réel s'arrête sur son résultat ou ses limites, et c'est sa politique
 * d'outils qui décide des approbations. Ils sont conservés parce que le profil
 * simulé reste le seul moyen d'exercer la machine à états sans dépenser de jetons.
 */
export const createTaskRequestSchema = z.object({
  objective: z.string().min(1).max(4000),
  /** Profil d'agent. Par défaut `simulated`, qui n'appelle aucun modèle. */
  agent_id: z.string().min(1).max(64).default('simulated'),
  /** Contexte fourni par Claude : ce que l'agent n'a pas à redécouvrir lui-même. */
  context: z.string().max(100_000).optional(),
  /**
   * Dossier que l'agent pourra lire. Le serveur MCP y met son propre dossier de
   * travail, c'est-à-dire le dépôt ouvert dans la session Claude Code.
   */
  project_dir: z.string().max(4096).optional(),
  /** Limites demandées. Elles ne peuvent qu'**abaisser** celles du profil. */
  limits: requestedLimitsSchema.optional(),
  /** Tâche simulée seulement : durée totale. */
  duration_s: z.number().int().min(1).max(900).default(20),
  /** Tâche simulée seulement : insère une pause d'approbation. */
  needs_approval: z.boolean().default(false),
})
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>

/** Réponse portant une tâche et la consigne associée. */
export const taskViewSchema = z.object({
  task: taskSchema,
  next_action: z.enum(NEXT_ACTIONS),
  /** Approbation en cours, s'il y en a une. */
  approval: approvalSchema.nullable().default(null),
})
export type TaskView = z.infer<typeof taskViewSchema>

/**
 * Réponse de `GET /api/tasks/:id/workspace` : le worktree d'une tâche et ce que
 * l'agent y a changé.
 *
 * Le diff est **calculé à la demande** contre le commit de départ, jamais lu
 * d'une copie figée : il dit ce qui est sur le disque au moment où on le lit,
 * travail non commité compris. Quand il ne peut pas l'être — tâche sans
 * worktree, worktree retiré ou supprimé à la main —, `unavailable` dit
 * pourquoi, et comment retrouver le travail s'il existe encore.
 */
export const taskWorkspaceResponseSchema = z.object({
  workspace: workspaceSchema.nullable(),
  diff: workspaceDiffSchema.nullable(),
  unavailable: z.string().nullable(),
})
export type TaskWorkspaceResponse = z.infer<typeof taskWorkspaceResponseSchema>

/** Un worktree tel que `harness workspaces` le montre : la ligne en base, et ce qu'il y a sur le disque. */
export const workspaceListingSchema = z.object({
  workspace: workspaceSchema,
  task_status: taskStatusSchema.nullable(),
  exists: z.boolean(),
  /** Chemins modifiés ou nouveaux non commités ; `null` si le worktree est absent ou illisible. */
  dirty: z.number().int().min(0).nullable(),
})
export type WorkspaceListing = z.infer<typeof workspaceListingSchema>

/** Réponse de `GET /api/workspaces`. */
export const workspacesResponseSchema = z.object({
  workspaces: z.array(workspaceListingSchema),
  /**
   * Dossiers sous `worktreesDir` qu'aucune ligne ne référence : reste d'un
   * crash entre la création du worktree et son enregistrement. **Montrés,
   * jamais supprimés d'office** — rien ne dit à qui ils sont.
   */
  orphans: z.array(z.string()),
  worktrees_dir: z.string(),
})
export type WorkspacesResponse = z.infer<typeof workspacesResponseSchema>

/** Corps de `POST /api/workspaces/:id/remove`. */
export const removeWorkspaceRequestSchema = z.object({
  /** Retirer même avec du travail non commité, que la branche ne contient pas. */
  force: z.boolean().default(false),
  by: z.string().min(1).max(64).default('cli'),
})

/** Réponse de `GET /api/exec-allow?project_dir=`. */
export const execAllowResponseSchema = z.object({
  repo_dir: z.string(),
  entries: z.array(execAllowEntrySchema),
  /** Liste blanche globale (`MIDGAARD_EXEC_ALLOW`), qui s'ajoute à celle du dépôt. */
  global: z.array(z.array(z.string())),
})
export type ExecAllowResponse = z.infer<typeof execAllowResponseSchema>

/** Corps de `POST /api/exec-allow` et `POST /api/exec-allow/remove`. */
export const execAllowRequestSchema = z.object({
  project_dir: z.string().min(1).max(4096),
  argv: z.array(z.string().min(1).max(4096)).min(1).max(64),
  by: z.string().min(1).max(64).default('cli'),
})

/** Réponse de `GET /api/agents`. */
export const agentsResponseSchema = z.object({ agents: z.array(agentSchema) })
export type AgentsResponse = z.infer<typeof agentsResponseSchema>

/** Réponse de `GET /api/providers`. Ne contient **aucune clé**, seulement des références. */
export const providersResponseSchema = z.object({
  providers: z.array(providerConfigSchema),
  /** Tarifs en vigueur, avec leur date de relevé : l'interface doit pouvoir dire s'ils ont vieilli. */
  pricing: z.object({ updated_at: z.iso.datetime(), source: z.string(), models: z.number().int().min(0) }),
})
export type ProvidersResponse = z.infer<typeof providersResponseSchema>

/**
 * Corps de `POST /api/providers` — déclaration ou mise à jour d'un fournisseur.
 *
 * `api_key` est le **seul** endroit du protocole où une clé circule, et elle n'y
 * fait que passer : le daemon la dépose dans le coffre système et n'en garde
 * qu'une référence. Elle n'est jamais relue, jamais renvoyée, jamais journalisée.
 */
export const upsertProviderRequestSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(200).optional(),
  preset: z.enum(PROVIDER_PRESETS).default('venice'),
  base_url: z.url().optional(),
  default_model: z.string().min(1),
  api_key: z.string().min(1).optional(),
  web_search: z.enum(WEB_SEARCH_MODES).optional(),
})
export type UpsertProviderRequest = z.infer<typeof upsertProviderRequestSchema>

/** Réponse de `POST /api/providers/:id/test` — le « Test connection » du plan. */
export const connectionTestResponseSchema = z.object({
  provider: providerConfigSchema,
  test: connectionTestSchema,
})
export type ConnectionTestResponse = z.infer<typeof connectionTestResponseSchema>

/** Réponse de `GET /api/tasks/:id/tools` — les appels d'outils d'une tâche. */
export const toolCallsResponseSchema = z.object({ tool_calls: z.array(toolCallSchema) })
export type ToolCallsResponse = z.infer<typeof toolCallsResponseSchema>

/** Réponse de `GET /api/pricing`. */
export const pricingResponseSchema = z.object({ pricing: pricingTableSchema })
export type PricingResponse = z.infer<typeof pricingResponseSchema>

/** Réponse de `GET /api/tasks/:id/wait`. */
export const waitResponseSchema = taskViewSchema.extend({
  waited_ms: z.number().int().min(0),
})
export type WaitResponse = z.infer<typeof waitResponseSchema>

// --- WebSocket -------------------------------------------------------------

/**
 * Sous-protocole WebSocket. Les navigateurs ne permettent pas de poser un
 * en-tête `Authorization` sur une connexion WebSocket : le jeton passe donc par
 * le sous-protocole, seul champ que l'API du navigateur laisse remplir.
 */
export const WS_SUBPROTOCOL = 'midgaard.v1'
/** Préfixe du second sous-protocole, qui porte le jeton : `midgaard-token.<jeton>`. */
export const WS_TOKEN_PREFIX = 'midgaard-token.'

/**
 * Messages envoyés par le daemon au dashboard.
 *
 * `snapshot` est toujours le premier : il porte l'état complet des tâches et les
 * événements manqués depuis le `since` demandé. `event` suit en temps réel.
 * Le client retient `seq` et le renvoie à la reconnexion — c'est ce qui garantit
 * qu'une coupure ne laisse pas de trou dans la timeline.
 */
export type ServerMessage =
  | {
      type: 'snapshot'
      /** Dernière séquence globale connue du serveur au moment du snapshot. */
      seq: number
      tasks: z.infer<typeof taskSchema>[]
      approvals: z.infer<typeof approvalSchema>[]
      /** Événements d'après le `since` demandé, dans l'ordre. Vide à la première connexion. */
      events: z.infer<typeof taskEventSchema>[]
      /** Vrai si `since` était trop ancien pour être rejoué : le client doit repartir du snapshot. */
      truncated: boolean
      health: Health
    }
  | { type: 'event'; event: z.infer<typeof taskEventSchema>; task: z.infer<typeof taskSchema> }
  | { type: 'approval'; approval: z.infer<typeof approvalSchema> }
  | { type: 'health'; health: Health }

/** Messages envoyés par le dashboard au daemon. Le ping sert à garder la connexion vivante. */
export type ClientMessage = { type: 'ping' }

/**
 * Nombre maximal d'événements rejoués lors d'une reprise. Au-delà, le serveur
 * répond `truncated: true` plutôt que de déverser tout le journal : le client
 * repart alors du snapshot, qui est de toute façon complet pour l'état courant.
 */
export const MAX_REPLAY_EVENTS = 2000
