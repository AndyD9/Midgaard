/**
 * @file La boucle d'exécution d'un agent.
 *
 * Elle ne connaît ni le daemon, ni la base, ni le coffre : elle reçoit un
 * adaptateur, un contexte d'outils et des crochets. C'est ce qui permet de
 * l'éprouver avec un faux fournisseur, sans réseau et sans dépense — et c'est
 * dans ces conditions qu'on peut tester ce qui compte vraiment : qu'un budget
 * arrête bien la tâche **avant** l'appel de trop.
 *
 * Déroulé d'une itération, dans cet ordre (§4 du plan) :
 *
 * ```text
 *  1. limites : annulation, délai, étapes, budget   ← AVANT l'appel modèle
 *  2. appel modèle
 *  3. consommation cumulée, diffusée
 *  4. pour chaque appel d'outil :
 *       schéma Zod → politique → [approbation humaine] → exécution → journal
 *  5. réinjection des résultats, et on recommence
 * ```
 *
 * Deux choix méritent d'être lus avant de modifier quoi que ce soit ici.
 *
 * **La fin est un acte, pas une interprétation.** Seul `submit_result` termine
 * une tâche. Un modèle qui écrit « voilà, j'ai fini » sans l'appeler n'a pas
 * fini : il a cessé de parler. La boucle le relance **une fois**, puis échoue en
 * le disant — plutôt que de rendre du texte libre là où Claude attend un
 * résultat exploitable.
 *
 * **Tout ce qui vient du dehors est encadré, même pour l'agent.** Un résultat
 * `untrusted` est enveloppé avant d'être réinjecté dans la conversation de
 * l'agent lui-même, pas seulement avant de remonter à Claude. L'agent est la
 * première cible d'une page qui essaie de détourner la tâche.
 */
import { randomUUID } from 'node:crypto'
import type { Agent, TaskResult, ToolCallStatus, ToolDecision, Usage } from '@midgaard/contracts'
import { addUsage, emptyUsage, wrapUntrusted } from '@midgaard/contracts'
import type { Message, ProviderAdapter, ToolCallRequest } from '@midgaard/providers'
import { ProviderError } from '@midgaard/providers'
import {
  SUBMIT_RESULT,
  canonicalRoot,
  findTool,
  submitResultSchema,
  toolSpecs,
  ToolError,
  type PreparedOperation,
  type ToolContext,
} from '@midgaard/tools'
import { budgetIsEnforceable, checkLimits, formatUsd, type StopReason } from './budget.ts'
import { buildMessages, workspaceTree } from './context.ts'

/** Décision humaine rendue sur une demande d'approbation. */
export type ApprovalOutcome = 'approved' | 'rejected' | 'expired'

/**
 * Ce qu'une demande d'approbation soumet à l'humain : le texte qu'il lit, et
 * la même opération structurée, dont l'empreinte est tirée.
 */
export interface ApprovalRequest {
  operation: string
  detail: Record<string, unknown>
}

/** Ce que la boucle journalise au moment où elle demande un outil. */
export interface ToolRequestedInput {
  step: number
  callId: string
  name: string
  decision: ToolDecision
  status: ToolCallStatus
  /** Arguments **déjà expurgés** par la boucle. */
  argumentsJson: string
}

/** Ce que la boucle journalise quand un outil rend la main. */
export interface ToolCompletedInput {
  status: ToolCallStatus
  summary: string | null
  bytes: number | null
  durationMs: number
  error: string | null
}

/**
 * Ce que la boucle demande au daemon.
 *
 * Toutes synchrones sauf {@link LoopHooks.requestApproval} : la boucle attend
 * réellement une décision humaine, et c'est le seul endroit où elle s'arrête
 * sans consommer.
 */
export interface LoopHooks {
  /** Texte produit par le modèle à cette itération. */
  onAgentMessage(text: string, step: number): void
  /** Consommation **cumulée** après un appel modèle. */
  onUsage(usage: Usage, step: number): void
  /** Note d'exécution destinée à l'utilisateur (avertissement, relance, refus). */
  onNote(message: string, step: number): void
  /** Journalise une demande d'appel d'outil. @returns l'identifiant du journal */
  onToolRequested(input: ToolRequestedInput): string
  /** Clôt un appel d'outil journalisé. */
  onToolCompleted(id: string, input: ToolCompletedInput): void
  /**
   * Suspend la tâche jusqu'à décision humaine. L'opération est **déjà
   * préparée** : ce qu'elle décrit est ce qui s'exécutera si l'humain accepte.
   */
  requestApproval(request: ApprovalRequest, step: number): Promise<ApprovalOutcome>
  /** Vrai si une annulation a été demandée depuis le dernier point de contrôle. */
  isCancelled(): boolean
}

/** Ce qu'il faut pour lancer une boucle. */
export interface LoopInput {
  agent: Agent
  objective: string
  context: string | null
  adapter: ProviderAdapter
  tools: ToolContext
  hooks: LoopHooks
  /** Expurgation appliquée à tout ce qui sera persisté ou journalisé. */
  redact: (text: string) => string
  /** Coupe les appels en cours quand la tâche est annulée. */
  signal: AbortSignal
  /** Injectable pour les tests, qui ne veulent pas d'horloge réelle. */
  now?: () => number
}

/** Ce que rend une boucle terminée. */
export type LoopOutcome =
  | { status: 'completed'; result: TaskResult; usage: Usage }
  | {
      status: 'failed' | 'cancelled' | 'timed_out' | 'budget_exceeded'
      error: string
      usage: Usage
    }

/** Issue d'une boucle qui n'a pas abouti à un résultat. */
type FailedOutcome = Extract<LoopOutcome, { error: string }>

/** Statut de tâche correspondant à chaque raison d'arrêt. */
const STOP_STATUS: Record<StopReason['kind'], FailedOutcome['status']> = {
  budget: 'budget_exceeded',
  steps: 'failed',
  timeout: 'timed_out',
  cancelled: 'cancelled',
}

/**
 * Exécute un agent jusqu'à son résultat, sa limite ou son annulation.
 *
 * @returns l'issue et la consommation finale — **toujours** la consommation,
 *          même sur échec : ce qui a été dépensé a été dépensé, et le cacher
 *          sur une tâche ratée est précisément ce qui rend les factures
 *          surprenantes
 */
export async function runAgent(input: LoopInput): Promise<LoopOutcome> {
  const now = input.now ?? (() => Date.now())
  const { limits } = { limits: input.agent.limits }
  const deadline = now() + limits.timeout_s * 1000
  let usage = emptyUsage()
  let step = 0
  let nudged = false
  // Combien de réponses sans appel d'outil ont été **coupées** au plafond de
  // sortie. C'est la différence entre « le modèle a refusé de conclure » et
  // « le modèle n'a pas eu la place de conclure » — deux pannes qui se
  // corrigent à l'opposé l'une de l'autre.
  let cutWithoutTools = 0

  // La racine est canonicalisée **ici**, une fois, et pas supposée l'être.
  // Sans cela, un projet situé sous un lien symbolique — ce qu'est `/tmp` sur
  // macOS, et ce que sont bien des dossiers personnels — verrait chacune de ses
  // lectures refusée par la vérification de chemin, qui compare un chemin réel
  // à une racine qui ne l'est pas. Le message d'erreur parlerait alors
  // d'échappée hors du projet pour un fichier qui en fait partie.
  let tools: ToolContext
  try {
    tools = {
      ...input.tools,
      root: await canonicalRoot(input.tools.root),
      // L'annulation et l'échéance de la tâche descendent jusqu'aux outils :
      // une commande lancée par `exec` doit mourir avec la tâche, et ne pas
      // durer au-delà de son délai — la boucle ne vérifie ses limites qu'entre
      // deux appels de modèle.
      signal: input.tools.signal ?? input.signal,
      deadline: input.tools.deadline ?? deadline,
    }
  } catch (e) {
    return { status: 'failed', error: input.redact((e as Error).message), usage: emptyUsage() }
  }
  const input2 = { ...input, tools }

  const tree = await workspaceTree(tools.root)
  // Les outils du profil, moins l'interrupteur de recherche web qui n'est pas
  // une fonction appelable (voir `WEB_SEARCH_IS_NOT_A_TOOL`).
  const specs = toolSpecs(input.agent.tools)
  const webSearch = input.agent.tools.includes('web_search') && input.adapter.supportsWebSearch

  const messages: Message[] = buildMessages({
    agent: input.agent,
    objective: input.objective,
    context: input.context,
    root: tools.root,
    tree,
    limits,
    // Au premier tour, la consommation est vide : c'est le tarif du modèle qui
    // dit si le budget pourra s'appliquer, et on ne le saura qu'après le premier
    // appel. On annonce donc l'optimisme, et on corrige après coup si besoin.
    budgetEnforceable: true,
  })

  let budgetWarned = false

  while (true) {
    const stop = checkLimits({ usage, step, limits, deadline, cancelled: input.hooks.isCancelled(), now: now() })
    if (stop) {
      return {
        status: STOP_STATUS[stop.kind],
        error: `${stop.detail} — ${usage.model_calls} appel(s) modèle, ${formatUsd(usage.cost_usd)}`,
        usage,
      }
    }

    step++
    let completion
    try {
      completion = await input.adapter.complete({
        messages,
        tools: specs,
        maxOutputTokens: limits.max_output_tokens,
        webSearch,
        signal: input.signal,
      })
    } catch (e) {
      if (input.hooks.isCancelled()) {
        return { status: 'cancelled', error: 'annulation demandée pendant un appel modèle', usage }
      }
      const message = e instanceof ProviderError ? e.message : input.redact((e as Error).message)
      return { status: 'failed', error: `appel modèle refusé : ${message}`, usage }
    }

    usage = addUsage(usage, completion.usage)
    input.hooks.onUsage(usage, step)

    // Prévenir une seule fois, et seulement une fois qu'on sait : annoncer
    // l'inapplicabilité du budget avant le premier appel serait deviner.
    if (!budgetWarned && !budgetIsEnforceable(usage)) {
      budgetWarned = true
      input.hooks.onNote(
        `tarif inconnu pour « ${input.adapter.model} » : le budget en dollars ne peut pas être appliqué, ` +
          `seule la limite de ${limits.max_steps} étapes borne cette tâche`,
        step,
      )
    }

    // Une recherche web native n'est pas un appel d'outil : elle se produit
    // pendant la réponse. On la journalise après coup pour qu'elle reste
    // visible, comptée et attribuée — sinon elle serait facturée sans trace.
    if (completion.citations.length > 0) {
      const id = input.hooks.onToolRequested({
        step,
        callId: `web_search-${step}`,
        name: 'web_search',
        decision: 'allow',
        status: 'running',
        argumentsJson: '{}',
      })
      input.hooks.onToolCompleted(id, {
        status: 'succeeded',
        summary: `${completion.citations.length} source(s) : ${completion.citations
          .map((c) => c.url)
          .slice(0, 5)
          .join(', ')}`,
        bytes: null,
        durationMs: 0,
        error: null,
      })
    }

    if (completion.text.trim()) input.hooks.onAgentMessage(input.redact(completion.text), step)
    messages.push({ role: 'assistant', content: completion.text, toolCalls: completion.toolCalls })

    if (completion.finishReason === 'length') {
      // Le conseil s'adresse à qui lit la note — Claude, ou l'utilisateur. Ni
      // l'un ni l'autre ne peut relever ce plafond : il appartient au profil, et
      // `tightenLimits` ne sait qu'abaisser. Dire « relève max_output_tokens »
      // envoyait donc vers une manette absente de `harness_delegate_task`.
      input.hooks.onNote(
        `réponse coupée à ${limits.max_output_tokens} jetons de sortie ; demande une réponse plus courte ` +
          `dans l'objectif — ce plafond appartient au profil de l'agent, une délégation ne peut que l'abaisser`,
        step,
      )
    }

    if (completion.toolCalls.length === 0) {
      if (completion.finishReason === 'length') cutWithoutTools++
      if (nudged) {
        // « Aucun outil appelé » est le symptôme ; la cause la plus fréquente est
        // une réponse tronquée avant que l'appel n'ait pu être émis. Les
        // confondre coûte cher : on croit à un plafond d'étapes trop bas et on
        // le relève, alors qu'il fallait raccourcir la réponse demandée. Cette
        // confusion a été commise pour de bon à la lecture du message d'origine
        // (docs/SLICE2.md, § défaut n° 2) — d'où la distinction, ici, à la source.
        return {
          status: 'failed',
          error:
            cutWithoutTools > 0
              ? `réponse coupée à ${limits.max_output_tokens} jetons de sortie avant tout appel d'outil ` +
                `(${cutWithoutTools} fois, relance comprise) : submit_result n'a jamais pu être émis. ` +
                `L'objectif demande une réponse trop longue — demande-la plus courte. Ce plafond appartient ` +
                `au profil de l'agent : une délégation ne peut que l'abaisser, jamais le relever.`
              : 'l\'agent s\'est arrêté sans appeler submit_result, même après relance — ' +
                'aucun résultat structuré à remonter. Reformule l\'objectif pour qu\'il appelle une ' +
                'réponse structurée, ou vérifie que submit_result lui est bien proposé.',
          usage,
        }
      }
      nudged = true
      input.hooks.onNote('aucun outil appelé : relance pour obtenir un résultat structuré', step)
      messages.push({
        role: 'user',
        content:
          'You did not call any tool. If you have the answer, call submit_result now with it. ' +
          'If you still need information, call a tool. Plain text alone does not end this task.',
      })
      continue
    }

    // Les fournisseurs savent demander plusieurs appels d'un coup. Au-delà de la
    // limite du profil, les surnuméraires sont refusés — en le disant au modèle,
    // pour qu'il les redemande à l'itération suivante plutôt que de les perdre.
    const accepted = completion.toolCalls.slice(0, limits.max_tool_calls_per_step)
    const refused = completion.toolCalls.slice(limits.max_tool_calls_per_step)

    for (const call of accepted) {
      if (call.name === SUBMIT_RESULT) {
        const submitted = finishWith(call, input, step, usage)
        if (submitted) return submitted
        // Charge utile invalide : on le dit au modèle et on continue, plutôt que
        // de perdre une tâche entière sur un champ mal rempli.
        messages.push({
          role: 'tool',
          callId: call.id,
          name: call.name,
          content: 'submit_result rejected: the payload did not match the schema. Fix it and call it again.',
        })
        continue
      }
      messages.push(await runOneTool(call, input2, step))
    }

    for (const call of refused) {
      messages.push({
        role: 'tool',
        callId: call.id,
        name: call.name,
        content: `Refused: at most ${limits.max_tool_calls_per_step} tool calls per step. Ask again next step.`,
      })
    }
  }
}

/**
 * Traite `submit_result`.
 * @returns l'issue si la charge utile est valide, `null` sinon
 */
function finishWith(
  call: ToolCallRequest,
  input: LoopInput,
  step: number,
  usage: Usage,
): LoopOutcome | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(call.argumentsJson)
  } catch {
    return null
  }
  const validated = submitResultSchema.safeParse(parsed)
  if (!validated.success) {
    input.hooks.onNote(
      `submit_result refusé : ${validated.error.issues[0]?.message ?? 'charge utile invalide'}`,
      step,
    )
    return null
  }

  const id = input.hooks.onToolRequested({
    step,
    callId: call.id,
    name: SUBMIT_RESULT,
    decision: 'allow',
    status: 'running',
    argumentsJson: JSON.stringify({ summary: validated.data.summary, confidence: validated.data.confidence }),
  })
  input.hooks.onToolCompleted(id, {
    status: 'succeeded',
    summary: `résultat soumis (confiance : ${validated.data.confidence})`,
    bytes: null,
    durationMs: 0,
    error: null,
  })

  const result: TaskResult = {
    summary: input.redact(validated.data.summary),
    details: input.redact(validated.data.details),
    steps: [],
    citations: validated.data.citations,
    // Le drapeau qui compte pour la suite : si l'agent a cité des sources web,
    // son résultat reprend du contenu que personne ne contrôle, et le serveur
    // MCP l'encadrera avant de le rendre à Claude.
    untrusted: validated.data.citations.length > 0,
  }
  return { status: 'completed', result, usage }
}

/**
 * Exécute un appel d'outil de bout en bout : schéma, politique, approbation,
 * exécution, journal.
 *
 * @returns le message de rôle `tool` à réinjecter — **toujours un message**,
 *          même sur refus : un appel sans réponse laisse le modèle attendre et
 *          brûle l'itération suivante à redemander la même chose
 */
async function runOneTool(call: ToolCallRequest, input: LoopInput, step: number): Promise<Message> {
  const reply = (content: string): Message => ({ role: 'tool', callId: call.id, name: call.name, content })

  // 1. L'outil est-il dans le profil ? Un outil hors profil n'est pas
  //    négociable : pas d'approbation, un refus.
  const tool = findTool(call.name)
  if (!tool || !input.agent.tools.includes(call.name)) {
    const id = input.hooks.onToolRequested({
      step, callId: call.id, name: call.name, decision: 'deny', status: 'denied',
      argumentsJson: input.redact(call.argumentsJson).slice(0, 4000),
    })
    input.hooks.onToolCompleted(id, {
      status: 'denied', summary: null, bytes: null, durationMs: 0,
      error: `outil « ${call.name} » absent du profil ${input.agent.id}`,
    })
    return reply(`Refused: tool "${call.name}" is not available to this agent.`)
  }

  // 2. Les arguments correspondent-ils au schéma ? L'erreur de validation est
  //    rendue au modèle : c'est elle qui lui permet de corriger son appel.
  let args: unknown
  try {
    args = JSON.parse(call.argumentsJson || '{}')
  } catch {
    return reply(`Refused: arguments were not valid JSON.`)
  }
  const validated = tool.schema.safeParse(args)
  if (!validated.success) {
    const detail = validated.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    return reply(`Refused: arguments do not match the schema. ${detail}`)
  }

  // 3. Politique, évaluée sur les arguments réels.
  const verdict = tool.policy(validated.data as never, input.tools)
  const argumentsJson = input.redact(JSON.stringify(validated.data)).slice(0, 4000)
  const logId = input.hooks.onToolRequested({
    step,
    callId: call.id,
    name: call.name,
    decision: verdict.decision,
    status: verdict.decision === 'approval' ? 'awaiting_approval' : 'running',
    argumentsJson,
  })

  if (verdict.decision === 'deny') {
    input.hooks.onToolCompleted(logId, {
      status: 'denied', summary: null, bytes: null, durationMs: 0, error: verdict.reason,
    })
    return reply(`Refused: ${verdict.reason}`)
  }

  // 4. Préparation : l'opération est figée — chemins, programme résolu — avant
  //    qu'un humain ne soit sollicité. Ce qu'il lira est ce qui tournera. Un
  //    échec ici (programme introuvable) se dit tout de suite au modèle, sans
  //    déranger personne.
  const started = Date.now()
  let prepared: PreparedOperation | undefined
  try {
    prepared = tool.prepare ? await tool.prepare(validated.data as never, input.tools) : undefined
  } catch (e) {
    const message = e instanceof ToolError ? e.message : input.redact((e as Error).message)
    input.hooks.onToolCompleted(logId, {
      status: 'failed', summary: null, bytes: null, durationMs: Date.now() - started, error: message,
    })
    return reply(`Failed: ${message}`)
  }

  // 5. Approbation humaine. C'est le seul endroit où la boucle attend sans
  //    consommer — et le seul que le modèle ne peut pas contourner.
  if (verdict.decision === 'approval') {
    // Le détail est persisté avec la demande : il passe par l'expurgation comme
    // tout ce qui s'écrit en base. Un agent peut glisser une clé dans un argument.
    const request: ApprovalRequest = prepared
      ? { operation: `${call.name} — ${input.redact(prepared.summary)}`, detail: redactDeep(prepared.detail, input.redact) }
      : // Un outil sans préparation est décrit par ses arguments validés : c'est
        // exactement ce que `run` recevra.
        {
          operation: `${call.name} — ${input.redact(verdict.reason)}`,
          detail: redactDeep({ tool: call.name, arguments: validated.data }, input.redact),
        }
    const outcome = await input.hooks.requestApproval(request, step)
    if (outcome !== 'approved') {
      input.hooks.onToolCompleted(logId, {
        status: outcome === 'rejected' ? 'rejected' : 'denied',
        summary: null, bytes: null, durationMs: 0,
        error: outcome === 'rejected' ? 'refusé par un humain' : 'aucune décision humaine dans le délai',
      })
      return reply(
        outcome === 'rejected'
          ? 'Refused by a human operator. Do not retry this call; find another way or submit what you have.'
          : 'No human decision within the allowed time. Do not retry; submit what you have.',
      )
    }
  }

  // 6. Exécution — de l'opération préparée, et d'elle seule.
  const running = Date.now()
  try {
    const result = await tool.run(validated.data as never, input.tools, prepared)
    input.hooks.onToolCompleted(logId, {
      status: 'succeeded',
      summary: input.redact(result.summary),
      bytes: result.bytes,
      durationMs: Date.now() - running,
      error: null,
    })
    // Le contenu extérieur est encadré **ici aussi**, pas seulement avant de
    // remonter à Claude : l'agent est la première cible d'une page qui essaie
    // de détourner sa tâche.
    const content = result.untrusted ? wrapUntrusted(result.summary, result.content) : result.content
    return reply(input.redact(content))
  } catch (e) {
    const message = e instanceof ToolError ? e.message : input.redact((e as Error).message)
    input.hooks.onToolCompleted(logId, {
      status: 'failed', summary: null, bytes: null, durationMs: Date.now() - running, error: message,
    })
    return reply(`Failed: ${message}`)
  }
}

/**
 * Applique l'expurgation à toutes les chaînes d'une valeur JSON, à toute
 * profondeur. Les clés restent : ce sont des noms de champ, pas des données.
 */
function redactDeep<T>(value: T, redact: (text: string) => string): T {
  if (typeof value === 'string') return redact(value) as T
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, redact)])) as T
  }
  return value
}

/** Identifiant d'appel de secours, quand un fournisseur n'en fournit pas. */
export function fallbackCallId(): string {
  return randomUUID()
}
