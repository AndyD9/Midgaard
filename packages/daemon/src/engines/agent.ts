/**
 * @file Moteur des agents réels : il relie la boucle d'exécution au daemon.
 *
 * Son travail tient en quatre points, et aucun n'est de la logique d'agent —
 * celle-là vit dans `@midgaard/agent-runtime`, qui ne connaît ni base ni daemon :
 *
 *  1. **Résoudre de quoi partir** : le fournisseur, sa clé dans le coffre, le
 *     tarif du modèle, la racine de lecture. Un échec ici arrête la tâche avec
 *     un message qui dit quoi faire, pas une trace de pile.
 *  2. **Traduire les crochets de la boucle en écritures du bus**, pour que tout
 *     ce que fait l'agent apparaisse dans la timeline en direct.
 *  3. **Faire attendre une décision humaine** : c'est le seul endroit où la
 *     boucle s'arrête sans consommer, et le seul que le modèle ne contourne pas.
 *  4. **Conclure** — en vérifiant d'abord que personne n'a conclu avant lui.
 *
 * Pour un Developer, deux temps s'ajoutent, et ils encadrent la boucle :
 *
 *  - **en `preparing`**, le worktree est créé et enregistré ; la racine des
 *    outils devient le worktree, et l'écriture y est ouverte ;
 *  - **à la fin**, le travail est commité sur la branche — seulement si la
 *    tâche a abouti : `submit_result` est l'acte qui fait d'une branche un
 *    résultat, et une tâche qui échoue ne doit pas laisser une branche qui en
 *    a l'air. Le worktree est conservé **dans tous les cas**, pour qu'on puisse
 *    lire ce que l'agent avait fait, même interrompu.
 *
 * Ce dernier point n'est pas de la prudence excessive. Un refus d'approbation ou
 * une expiration fait passer la tâche en `cancelled` ou `timed_out` **pendant**
 * que la boucle tourne encore ; elle rendra ensuite son propre verdict, sur une
 * tâche déjà terminée. Écrire alors ferait lever `IllegalTransitionError` et
 * remplacerait un historique juste par un historique faux.
 */
import type { Agent, AgentKind, Approval, PricingTable, Task, TaskWorkspace, Workspace } from '@midgaard/contracts'
import { createRedactor, isTerminal, type Usage } from '@midgaard/contracts'
import { agentIdentity, commitAll, createWorktree, diffWorktree, inspectRepository, WorkspaceError } from '@midgaard/workspace'
import { createAdapter, envVarFor } from '@midgaard/providers'
import { resolveApiKey, type SecretVault } from '@midgaard/secrets'
import type { ToolContext } from '@midgaard/tools'
import { runAgent, type ApprovalOutcome, type LoopHooks, type LoopOutcome } from '@midgaard/agent-runtime'
import type { EngineContext, TaskEngine } from './types.ts'

/** Ce que le moteur emprunte au daemon, en plus du contexte commun. */
export interface AgentEngineDeps {
  /**
   * Profil exécuté par cette instance. Le gérant range ses moteurs par type de
   * profil ; Researcher et Developer partagent la même boucle, avec deux
   * instances de ce moteur.
   */
  kind: Extract<AgentKind, 'researcher' | 'developer'>
  ctx: EngineContext
  vault: SecretVault
  /** Lue à chaque tâche : un rafraîchissement des tarifs profite à la suivante. */
  pricing: () => PricingTable
  /** Environnement du daemon, consulté en dernier recours pour une clé. */
  env: NodeJS.ProcessEnv
}

/** État d'une tâche en vol dans ce processus. */
interface Running {
  abort: AbortController
  cancelled: boolean
  /** Résolution de l'attente d'approbation en cours, s'il y en a une. */
  decide: ((outcome: ApprovalOutcome) => void) | null
}

/** Exécute les profils qui appellent réellement un modèle. */
export class AgentEngine implements TaskEngine {
  readonly kind: AgentKind
  private readonly deps: AgentEngineDeps
  private readonly running = new Map<string, Running>()

  constructor(deps: AgentEngineDeps) {
    this.deps = deps
    this.kind = deps.kind
  }

  start(task: Task, agent: Agent): void {
    // Volontairement non attendu : un moteur qui bloque bloquerait le daemon
    // entier, long-polls compris. Les erreurs sont traitées dans `execute`.
    void this.execute(task, agent)
  }

  /** Une approbation accordée débloque l'attente de la boucle, là où elle en était. */
  resume(task: Task): void {
    this.running.get(task.id)?.decide?.('approved')
  }

  /**
   * Annulation **coopérative** : on lève le drapeau et on coupe l'appel HTTP en
   * cours, mais c'est la boucle qui conclut, à son prochain point de contrôle.
   *
   * @returns toujours `false` : le gérant ne doit pas conclure à sa place, sinon
   *          la tâche serait marquée annulée pendant qu'un appel modèle tourne
   *          encore, et sa consommation ne serait jamais comptée
   */
  cancel(task: Task): boolean {
    const state = this.running.get(task.id)
    if (!state) return true
    state.cancelled = true
    state.decide?.('rejected')
    state.abort.abort()
    return false
  }

  stop(): void {
    for (const state of this.running.values()) {
      state.cancelled = true
      state.decide?.('rejected')
      state.abort.abort()
    }
    this.running.clear()
  }

  // --- Exécution -----------------------------------------------------------

  private async execute(task: Task, agent: Agent): Promise<void> {
    const { ctx } = this.deps
    const state: Running = { abort: new AbortController(), cancelled: false, decide: null }
    this.running.set(task.id, state)
    let workspace: Workspace | null = null
    let outcome: LoopOutcome | null = null

    try {
      const ready = await this.prepare(task, agent)
      if ('error' in ready) {
        this.conclude(task.id, { status: 'failed', error: ready.error, usage: emptyish() })
        return
      }

      ctx.bus.record(task.id, 'preparing', {
        type: 'task.started',
        payload: {
          message: `exécution par ${agent.name} via ${ready.providerId} (${ready.model})`,
          agent_id: agent.id,
          provider_id: ready.providerId,
          model: ready.model,
        },
      })

      // Le worktree se crée **en `preparing`** : c'est un checkout complet, qui
      // peut durer, et une tâche qui afficherait `running` sans avoir commencé
      // mentirait sur ce qui la retient.
      if (agent.kind === 'developer') {
        const made = await this.makeWorkspace(task)
        if ('error' in made) {
          this.conclude(task.id, { status: 'failed', error: made.error, usage: emptyish() })
          return
        }
        workspace = made.workspace
        ready.tools = {
          ...ready.tools,
          // La racine des outils devient le worktree — plus le sous-dossier
          // délégué, pour un monorepo ouvert sur `packages/api`. Lecture,
          // écriture et commandes s'y font ; le dépôt de l'utilisateur n'est
          // plus atteignable.
          root: made.root,
          writable: true,
          workspace: {
            path: workspace.worktree_path,
            baseCommit: workspace.base_commit,
            submodules: workspace.submodules,
          },
          // La liste blanche du dépôt s'ajoute à la globale. Lue ici, au départ
          // de la tâche : un ajout fait pendant qu'elle tourne vaut pour la
          // suivante, pas pour celle-ci — une autorisation ne s'élargit pas
          // en cours de route.
          execAllow: [
            ...ctx.config.execAllow,
            ...ctx.store.listExecAllow(workspace.repo_dir).map((e) => e.argv),
          ],
        }
      }

      // `preparing → running` tout de suite : la préparation est faite, et un
      // statut qui ne bouge plus pendant une minute d'appel modèle laisse
      // croire que rien ne se passe.
      ctx.bus.record(task.id, 'running', {
        type: 'task.progress',
        payload: { step: 0, message: 'appel du modèle' },
      })

      outcome = await runAgent({
        agent: { ...agent, limits: task.limits },
        objective: task.objective,
        context: task.context,
        adapter: ready.adapter,
        tools: ready.tools,
        hooks: this.hooks(task.id, state),
        redact: ready.redact,
        signal: state.abort.signal,
        workspace: workspace
          ? {
              branch: workspace.branch,
              baseCommit: workspace.base_commit,
              baseDirty: workspace.base_dirty,
              submodules: submodulesUnder(workspace.submodules, workspace.subdir),
              originDir: task.project_dir ?? workspace.repo_dir,
            }
          : undefined,
      })
      if (workspace && outcome.status === 'completed') outcome = await this.commitWork(task, agent, workspace, outcome)
      this.conclude(task.id, outcome)
    } catch (e) {
      ctx.log(`tâche ${task.id.slice(0, 8)} : erreur inattendue`, e)
      this.conclude(task.id, {
        status: 'failed',
        error: `erreur inattendue du moteur : ${(e as Error).message}`,
        usage: outcome?.usage ?? emptyish(),
      })
    } finally {
      this.running.delete(task.id)
      // Conservé dans tous les cas, jamais retiré : ce qu'il contient est
      // peut-être la seule trace de ce que l'agent avait fait (PLAN §9.4).
      if (workspace) {
        const final = ctx.store.getTask(task.id)
        ctx.bus.setWorkspaceStatus(workspace.id, 'kept', { reason: `tâche ${final?.status ?? 'terminée'}` })
      }
    }
  }

  /**
   * Crée et enregistre le worktree d'une tâche Developer.
   *
   * @returns le worktree et la racine de travail de l'agent, ou une phrase qui
   *          dit quoi faire — un dossier qui n'est pas un dépôt Git est l'échec
   *          le plus probable, et il doit se comprendre sans lire de trace
   */
  private async makeWorkspace(task: Task): Promise<{ workspace: Workspace; root: string } | { error: string }> {
    const { ctx } = this.deps
    if (!task.project_dir) {
      return { error: 'aucun dossier de projet transmis à la délégation : impossible de créer un worktree' }
    }
    try {
      const repo = await inspectRepository(task.project_dir)
      const made = await createWorktree({ repo, worktreesDir: ctx.config.worktreesDir, taskId: task.id })
      const recorded = ctx.bus.createWorkspace({
        taskId: task.id,
        repoDir: repo.toplevel,
        subdir: repo.subdir,
        worktreePath: made.path,
        branch: made.branch,
        baseCommit: made.baseCommit,
        baseRef: repo.ref,
        baseDirty: repo.dirty,
        submodules: made.submodules,
      })
      if (!recorded) return { error: 'tâche disparue pendant la création du worktree' }
      ctx.log(`tâche ${task.id.slice(0, 8)} : worktree ${made.branch} créé (${made.path})`)
      return { workspace: recorded.workspace, root: made.root }
    } catch (e) {
      const message = e instanceof WorkspaceError ? e.message : (e as Error).message
      return { error: `worktree impossible : ${message}` }
    }
  }

  /**
   * Commite le travail d'une tâche aboutie, et décrit le worktree dans son
   * résultat.
   *
   * Un commit qui échoue fait échouer la tâche : le résultat annoncerait sinon
   * une branche qui ne contient pas le travail, et Claude enverrait
   * l'utilisateur merger du vide. Le travail, lui, reste dans le worktree, et
   * le message d'erreur dit où.
   */
  private async commitWork(
    task: Task,
    agent: Agent,
    workspace: Workspace,
    outcome: Extract<LoopOutcome, { status: 'completed' }>,
  ): Promise<LoopOutcome> {
    const firstLine = task.objective.split('\n')[0]!.trim()
    const subject = firstLine.length > 72 ? `${firstLine.slice(0, 71)}…` : firstLine
    const message = `${subject}\n\n${outcome.result.summary}\n\nTâche Midgaard ${task.id}, agent ${agent.id}.`
    try {
      const commit = await commitAll(workspace.worktree_path, message, agentIdentity(agent.id))
      const diff = await diffWorktree(workspace.worktree_path, workspace.base_commit)
      const described: TaskWorkspace = {
        branch: workspace.branch,
        base_commit: workspace.base_commit,
        commit,
        worktree_path: workspace.worktree_path,
        files_changed: diff.files.length,
        additions: diff.additions,
        deletions: diff.deletions,
        base_dirty: workspace.base_dirty,
        submodules: workspace.submodules,
      }
      return { ...outcome, result: { ...outcome.result, workspace: described } }
    } catch (e) {
      return {
        status: 'failed',
        error:
          `l'agent a rendu son résultat, mais le commit de fin a échoué (${(e as Error).message}) : ` +
          `le travail est resté non commité dans ${workspace.worktree_path}, sur ${workspace.branch}`,
        usage: outcome.usage,
      }
    }
  }

  /**
   * Rassemble tout ce qu'il faut pour partir : fournisseur, clé, adaptateur,
   * contexte d'outils.
   *
   * Chaque échec rend une **phrase actionnable**. C'est le moment où
   * l'utilisateur apprend qu'il a oublié une clé, et un message du genre
   * « Cannot read property of undefined » ne le lui apprendrait pas.
   */
  private async prepare(
    task: Task,
    agent: Agent,
  ): Promise<
    | { error: string }
    | {
        adapter: ReturnType<typeof createAdapter>
        tools: ToolContext
        redact: (t: string) => string
        providerId: string
        model: string
      }
  > {
    const { ctx } = this.deps
    if (!agent.provider_id) {
      return { error: `le profil « ${agent.id} » n'a aucun fournisseur configuré` }
    }
    const provider = ctx.store.getProvider(agent.provider_id)
    if (!provider) {
      return { error: `le fournisseur « ${agent.provider_id} » n'existe plus ; reconfigure le profil` }
    }

    const envVar = envVarFor(provider)
    const found = await resolveApiKey(this.deps.vault, provider.secret_ref, envVar, this.deps.env)
    if (!found) {
      return {
        error:
          `aucune clé d'API pour « ${provider.id} » : dépose-la avec ` +
          `\`harness providers set ${provider.id}\`, ou définis ${envVar} dans l'environnement du daemon`,
      }
    }
    if (found.source === 'env') {
      ctx.log(`fournisseur ${provider.id} : clé lue dans ${envVar} (dépannage), pas dans le coffre`)
    }

    // Tout ce qui sera journalisé ou persisté passe par là. La clé en est le
    // secret connu ; les motifs couvrent celles qu'on ne connaît pas et qui
    // pourraient traverser un outil.
    const redact = createRedactor([found.key])
    const model = agent.model ?? provider.default_model

    if (!task.project_dir) {
      return {
        error:
          'aucun dossier de projet transmis à la délégation : le serveur MCP doit fournir project_dir ' +
          '(mets à jour Midgaard, puis ouvre une nouvelle session Claude Code)',
      }
    }

    return {
      adapter: createAdapter({ config: provider, apiKey: found.key, model, pricing: this.deps.pricing(), redact }),
      tools: {
        root: task.project_dir,
        httpPolicy: ctx.config.httpPolicy,
        allowHosts: ctx.config.allowHosts,
        // Aucun profil n'a encore de worktree : la racine est le dépôt de
        // l'utilisateur, où rien ne s'écrit jamais. Les outils d'écriture
        // refusent donc, même si un profil les recevait par erreur. Le profil
        // `developer` posera ces deux champs sur son worktree (Slice 3, étape 5).
        writable: false,
        workspace: null,
        execAllow: ctx.config.execAllow,
        signal: undefined,
        log: ctx.log,
      },
      redact,
      providerId: provider.id,
      model,
    }
  }

  /** Traduit les crochets de la boucle en écritures du bus. */
  private hooks(taskId: string, state: Running): LoopHooks {
    const { ctx } = this.deps
    return {
      onAgentMessage: (text, step) => {
        ctx.bus.record(taskId, null, { type: 'agent.message', payload: { message: text, step } }, { step })
      },

      onNote: (message, step) => {
        ctx.bus.record(taskId, null, { type: 'agent.message', payload: { message, step, note: true } })
      },

      onUsage: (usage: Usage, step) => {
        // La consommation est écrite **dans la tâche** en même temps que
        // l'événement : le dashboard voit le budget se remplir pendant la tâche,
        // au lieu de découvrir la facture à la fin.
        ctx.bus.record(taskId, null, { type: 'usage.updated', payload: { usage, step } }, { usage, step })
      },

      onToolRequested: (input) => {
        const call = ctx.store.createToolCall({
          taskId,
          step: input.step,
          callId: input.callId,
          name: input.name,
          decision: input.decision,
          status: input.status,
          argumentsJson: input.argumentsJson,
        })
        ctx.bus.record(taskId, null, {
          type: 'tool.requested',
          payload: {
            tool_call_id: call.id,
            name: input.name,
            decision: input.decision,
            arguments: input.argumentsJson,
            step: input.step,
          },
        })
        return call.id
      },

      onToolCompleted: (id, input) => {
        ctx.store.finishToolCall(id, {
          status: input.status,
          summary: input.summary,
          bytes: input.bytes,
          durationMs: input.durationMs,
          error: input.error,
        })
        ctx.bus.record(taskId, null, {
          type: 'tool.completed',
          payload: {
            tool_call_id: id,
            status: input.status,
            summary: input.summary,
            duration_ms: input.durationMs,
            error: input.error,
          },
        })
      },

      requestApproval: ({ operation, detail }, step) =>
        new Promise<ApprovalOutcome>((resolve) => {
          const approval: Approval | null = ctx.requestApproval(taskId, operation, detail, { step })
          if (!approval) return resolve('rejected')
          // La décision arrivera par `resume` (accordée) ou par `cancel`
          // (refusée, annulée, expirée). Résolue une seule fois : la seconde
          // tentative ne doit pas relancer une boucle déjà repartie.
          let settled = false
          state.decide = (outcome) => {
            if (settled) return
            settled = true
            state.decide = null
            resolve(outcome)
          }
        }),

      isCancelled: () => {
        if (state.cancelled) return true
        // Une tâche devenue terminale pendant qu'on tournait — refus humain,
        // expiration, annulation — doit arrêter la boucle au point de contrôle
        // suivant, avant qu'un appel modèle de plus ne soit payé pour rien.
        const current = ctx.store.getTask(taskId)
        return !current || isTerminal(current.status)
      },
    }
  }

  /**
   * Écrit le verdict de la boucle, **si personne ne l'a devancée**.
   *
   * Une tâche déjà terminale a été conclue par un refus humain, une expiration
   * ou une annulation. Écrire par-dessus lèverait `IllegalTransitionError` et
   * remplacerait un historique juste par un historique faux.
   */
  private conclude(taskId: string, outcome: LoopOutcome): void {
    const { ctx } = this.deps
    const current = ctx.store.getTask(taskId)
    if (!current) return
    if (isTerminal(current.status)) {
      ctx.log(`tâche ${taskId.slice(0, 8)} déjà ${current.status} : verdict du moteur ignoré`)
      return
    }

    if (outcome.status === 'completed') {
      ctx.bus.record(
        taskId,
        'completed',
        { type: 'task.completed', payload: { result: outcome.result, usage: outcome.usage } },
        { result: outcome.result, usage: outcome.usage },
      )
      ctx.log(`tâche ${taskId.slice(0, 8)} terminée (${outcome.usage.model_calls} appel(s))`)
      return
    }

    const EVENT = {
      failed: 'task.failed',
      cancelled: 'task.cancelled',
      timed_out: 'task.timed_out',
      budget_exceeded: 'task.budget_exceeded',
    } as const

    // `cancel_requested` ne peut pas aller directement en `timed_out` ni
    // `budget_exceeded` : une tâche qu'on annule s'arrête annulée, quelle que
    // soit la limite qu'elle aurait franchie au même instant.
    const status =
      current.status === 'cancel_requested' && outcome.status !== 'failed' ? 'cancelled' : outcome.status

    ctx.bus.record(
      taskId,
      status,
      { type: EVENT[status], payload: { reason: outcome.error, usage: outcome.usage } },
      { error: outcome.error, usage: outcome.usage },
    )
    ctx.log(`tâche ${taskId.slice(0, 8)} → ${status} : ${outcome.error}`)
  }
}

/** Consommation nulle, pour les échecs survenus avant tout appel modèle. */
function emptyish(): Usage {
  return {
    model_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cached_tokens: 0,
    web_searches: 0,
    cost_usd: 0,
    cost_source: 'unknown',
    cost_usd_estimated: null,
    cost_usd_reported: null,
  }
}

/**
 * Sous-modules vus depuis la racine de l'agent, qui peut être un sous-dossier
 * du dépôt (`subdir`, avec `/` final ou vide) : ceux qui sont hors de ce
 * sous-dossier ne le concernent pas, les autres perdent son préfixe.
 */
export function submodulesUnder(submodules: readonly string[], subdir: string): string[] {
  return submodules.filter((p) => p.startsWith(subdir)).map((p) => p.slice(subdir.length))
}
