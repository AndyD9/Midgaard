/**
 * @file L'environnement Python d'un worktree, préparé par le harness avant
 * l'agent (Slice 9, étape 4, décision 8).
 *
 * Un worktree n'a pas de `.venv` : il n'est pas versionné. Sans lui, un
 * Developer sur un projet Python commence par le recréer, et chaque commande
 * qui l'installe est une approbation de plus. Le harness propose donc
 * **lui-même** `uv sync --locked`, une fois, avant le premier appel de modèle :
 *
 *  - **à ce moment l'arbre est celui du commit de départ** : la construction
 *    du paquet local lance du code de l'utilisateur, pas de l'agent ;
 *  - **l'humain approuve**, comme toute commande : elle télécharge des paquets
 *    et lance un backend de construction. Refuser arrête la tâche, comme tout
 *    refus — l'opération le dit ;
 *  - **`--locked`** : `uv.lock` est lu tel quel, et `uv sync` échoue plutôt
 *    que de le réécrire. Un `uv.lock` récrit par le harness apparaîtrait au
 *    diff comme le travail de l'agent. Sans `uv.lock` (un `pyproject.toml`
 *    seul), rien n'est proposé, et c'est dit ;
 *  - **le `.venv` de l'utilisateur n'est jamais partagé** : celui-ci est
 *    créé dans le worktree, et `uv` y pose un `.gitignore` qui le tient hors
 *    du diff et du commit.
 *
 * La commande passe par l'outil `exec` lui-même — programme résolu avant la
 * demande, revérifié avant de lancer, groupe de processus tué, sortie en
 * direct — et s'inscrit à la timeline comme un appel d'outil de l'étape 0,
 * avec une opération qui dit que c'est le harness qui la lance.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { OutputBatcher, type ApprovalOutcome, type LoopHooks } from '@midgaard/agent-runtime'
import { findTool, ToolError, type PreparedOperation, type ToolContext } from '@midgaard/tools'

/** Ce que la préparation a donné. */
export type PythonEnvOutcome =
  /** Aucun `uv.lock` : rien à faire. `note` dit pourquoi quand un `pyproject.toml` est là. */
  | { kind: 'skipped'; note: string | null }
  /** Commande lancée ; `context` est la phrase ajoutée au contexte de l'agent. */
  | { kind: 'ran'; ok: boolean; context: string }
  /** Pas d'accord humain : la tâche s'arrête (refus, expiration, annulation). */
  | { kind: 'stopped'; outcome: Exclude<ApprovalOutcome, 'approved'> }

/** Délai de `uv sync`, en secondes : un premier téléchargement peut être long. */
export const UV_SYNC_TIMEOUT_S = 600

/** Identifiant d'appel de la commande du harness, distinct de ceux du modèle. */
const CALL_ID = 'harness-uv-sync'

/**
 * Propose et lance `uv sync --locked` à la racine des outils, si elle porte
 * un `uv.lock`.
 *
 * @param tools    contexte des outils de la tâche (racine = worktree), avec
 *                 le signal d'annulation de la tâche : il tue `uv` et ses fils
 * @param hooks    crochets de la tâche : journal d'outil, approbation, sortie
 * @param redact   expurgation de la tâche
 * @param timeoutS délai de la tâche : la commande ne le dépasse pas, compté
 *                 **après** la décision humaine, qui ne consomme rien
 */
export async function preparePythonEnv(
  tools: ToolContext,
  hooks: LoopHooks,
  redact: (text: string) => string,
  timeoutS: number,
): Promise<PythonEnvOutcome> {
  if (!existsSync(join(tools.root, 'uv.lock'))) {
    return {
      kind: 'skipped',
      note: existsSync(join(tools.root, 'pyproject.toml'))
        ? 'environnement Python non préparé : pyproject.toml sans uv.lock (uv sync écrirait un uv.lock que le diff attribuerait à l\'agent)'
        : null,
    }
  }
  const exec = findTool('exec')!
  const args = exec.schema.parse({ command: 'uv', args: ['sync', '--locked'], cwd: '.', timeout_s: UV_SYNC_TIMEOUT_S })

  let prepared: PreparedOperation
  try {
    prepared = await exec.prepare!(args as never, tools)
  } catch (e) {
    const why = e instanceof ToolError ? e.message : String(e)
    return { kind: 'skipped', note: `environnement Python non préparé : uv introuvable ou inutilisable (${redact(why)})` }
  }

  const logId = hooks.onToolRequested({
    step: 0,
    callId: CALL_ID,
    name: 'exec',
    decision: 'approval',
    status: 'awaiting_approval',
    argumentsJson: redact(JSON.stringify(args)),
  })
  const outcome = await hooks.requestApproval(
    {
      operation:
        `exec — le harness prépare l'environnement Python du worktree avant l'agent : ${redact(prepared.summary)}. ` +
        'Refuser arrête la tâche.',
      detail: { ...prepared.detail, purpose: 'python_environment' },
    },
    0,
  )
  if (outcome !== 'approved') {
    hooks.onToolCompleted(logId, {
      status: outcome === 'rejected' ? 'rejected' : 'denied',
      summary: null,
      bytes: null,
      durationMs: 0,
      error: outcome === 'rejected' ? 'refusé par un humain' : 'aucune décision humaine',
    })
    return { kind: 'stopped', outcome }
  }

  const started = Date.now()
  const onOutput = hooks.onToolOutput
  const batcher = onOutput ? new OutputBatcher({ redact, emit: (batch) => onOutput(logId, batch) }) : null
  const bounded: ToolContext = { ...tools, deadline: Date.now() + timeoutS * 1000 }
  const withOutput: ToolContext = batcher ? { ...bounded, output: (s, c) => batcher.write(s, c) } : bounded
  try {
    const result = await exec.run(args as never, withOutput, prepared)
    batcher?.close()
    hooks.onToolCompleted(logId, {
      status: 'succeeded',
      summary: redact(result.summary),
      bytes: result.bytes,
      durationMs: Date.now() - started,
      error: null,
    })
    const ok = result.exit_code === 0
    return {
      kind: 'ran',
      ok,
      context: ok
        ? 'Before you started, the harness prepared the Python environment of your workspace with ' +
          '`uv sync --locked` (approved by a human). Run Python tools inside it with `uv run …`.'
        : 'Before you started, the harness tried to prepare the Python environment with `uv sync --locked`, ' +
          `and it failed (exit code ${result.exit_code ?? 'none: killed'}). The environment may be missing or ` +
          'incomplete; say so in your result if it blocks you.',
    }
  } catch (e) {
    batcher?.close()
    const message = redact((e as Error).message)
    hooks.onToolCompleted(logId, {
      status: 'failed',
      summary: null,
      bytes: null,
      durationMs: Date.now() - started,
      error: message,
    })
    return {
      kind: 'ran',
      ok: false,
      context:
        'Before you started, the harness tried to prepare the Python environment with `uv sync --locked`, and ' +
        'could not run it. The environment is missing; say so in your result if it blocks you.',
    }
  }
}
