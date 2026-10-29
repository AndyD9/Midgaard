/**
 * @file Interface commune des fournisseurs, et le vocabulaire minimal que la
 * boucle connaît.
 *
 * **Tout ce qui diffère entre fournisseurs se normalise ici, jamais dans la
 * boucle** (§4 du plan). OpenAI rend des `tool_calls` avec des arguments en
 * chaîne JSON, Gemini des `functionCall` avec des arguments déjà désérialisés ;
 * OpenAI veut un message de rôle `tool`, Gemini une `functionResponse` dans un
 * `Content` de rôle `user`. La boucle, elle, ne voit que
 * `{ text, toolCalls[], usage }` — et c'est ce qui permet d'ajouter un
 * fournisseur sans la rouvrir.
 */
import type { ConnectionTest, ProviderPreset, Usage } from '@midgaard/contracts'

/**
 * Un outil, tel qu'il est décrit au modèle.
 *
 * `parameters` est un JSON Schema, engendré depuis le schéma Zod de l'outil :
 * une seule définition sert à la fois à décrire l'outil au modèle et à valider
 * ce qu'il renvoie. Deux définitions finiraient par diverger, et la divergence
 * se verrait en production, pas en test.
 */
export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** Un appel d'outil demandé par le modèle. */
export interface ToolCallRequest {
  /** Identifiant rendu par le fournisseur, à renvoyer avec le résultat. */
  id: string
  name: string
  /** Arguments en JSON, **non validés** : c'est la boucle qui les passe au schéma Zod. */
  argumentsJson: string
}

/** Un message de la conversation, dans la forme neutre que la boucle manipule. */
export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls: ToolCallRequest[] }
  | { role: 'tool'; callId: string; name: string; content: string }

/** Pourquoi le modèle s'est arrêté. */
export const FINISH_REASONS = ['stop', 'tool_calls', 'length', 'other'] as const
export type FinishReason = (typeof FINISH_REASONS)[number]

/** Ce qu'on demande au modèle. */
export interface CompletionRequest {
  messages: Message[]
  tools: ToolSpec[]
  /** Borne la taille — donc le coût — d'une seule réponse. */
  maxOutputTokens: number
  /** Demande la recherche web native, si le fournisseur en a une. */
  webSearch: boolean
  /** Annulation : coupe l'appel HTTP si la tâche est annulée. */
  signal?: AbortSignal | undefined
}

/** Ce que le modèle a répondu, normalisé. */
export interface CompletionResponse {
  text: string
  toolCalls: ToolCallRequest[]
  usage: Usage
  /** Sources citées par une recherche web native. Vide sinon. */
  citations: { title: string; url: string }[]
  finishReason: FinishReason
}

/**
 * Un adaptateur de fournisseur.
 *
 * Instancié par appel de tâche, avec la clé déjà résolue depuis le coffre :
 * l'adaptateur ne connaît ni le coffre ni l'environnement.
 */
export interface ProviderAdapter {
  /** Identifiant de la configuration, par exemple `venice`. */
  readonly id: string
  readonly preset: ProviderPreset
  readonly model: string
  /** Vrai si ce fournisseur sait chercher sur le web sans outil tiers. */
  readonly supportsWebSearch: boolean
  /** Un aller-retour avec le modèle. Ne relance pas la boucle : c'est son rôle à elle. */
  complete(request: CompletionRequest): Promise<CompletionResponse>
  /** « Test connection » : joint l'endpoint, et dit ce qu'il a vu. */
  testConnection(signal?: AbortSignal): Promise<ConnectionTest>
}

/**
 * Erreur d'un fournisseur, avec de quoi décider s'il faut réessayer.
 *
 * La distinction porte : une clé invalide ne se répare pas en réessayant, une
 * limite de débit si. Réessayer sur la première gaspille le budget de la tâche
 * et retarde un message d'erreur que l'utilisateur doit lire tout de suite.
 */
export class ProviderError extends Error {
  readonly status: number | null
  readonly retryable: boolean
  readonly provider: string

  constructor(provider: string, message: string, status: number | null, retryable: boolean) {
    super(message)
    this.name = 'ProviderError'
    this.provider = provider
    this.status = status
    this.retryable = retryable
  }
}
