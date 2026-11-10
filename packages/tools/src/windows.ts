/**
 * @file `windows_run` : lancer un script PowerShell sur la VM Windows de test
 * de la tâche, sous approbation humaine (Slice 9, étape 5.3c).
 *
 * L'outil ne connaît ni SSH, ni la base, ni le daemon : il parle à un
 * {@link WindowsPort}, posé par le daemon pour un Developer dont le profil a
 * une VM (sous-étape 5.3d). Le port recopie le worktree sur la VM, lance le
 * script, puis ferme la connexion.
 *
 * Les garanties, dans l'esprit d'`exec` :
 *
 *  1. Sans port, refus sans rien demander — fermé par défaut.
 *  2. Une approbation à chaque appel ; aucune liste blanche ne s'y applique.
 *  3. L'humain lit la VM visée (identifiant, adresse, compte, empreinte) et le
 *     script exact, et c'est de ce détail que l'empreinte de l'approbation est
 *     tirée.
 *  4. Si la VM a changé entre l'approbation et l'exécution (redéclarée, autre
 *     empreinte), rien ne tourne : on lance ce qui a été montré, ou rien.
 *  5. Le délai est borné par l'échéance de la tâche, comme `exec`.
 *  6. La sortie part en direct vers le terminal, et le résultat est toujours
 *     marqué non fiable : elle vient d'une VM qu'un échantillon a pu salir.
 */
import { z } from 'zod'
import type { ToolResult } from '@midgaard/contracts'
import type { WindowsTarget } from './types.ts'
import { ToolError, type PreparedOperation, type Tool } from './types.ts'

/** Délai par défaut d'un script, en secondes. */
export const WINDOWS_DEFAULT_TIMEOUT_S = 120
/** Délai maximal qu'un agent peut demander. */
export const WINDOWS_MAX_TIMEOUT_S = 600
/**
 * Longueur maximale d'un script en ligne. `cmd.exe`, shell par défaut de
 * Win32-OpenSSH, borne la ligne de commande à 8 191 caractères ; le script
 * voyage en base64 d'UTF-16LE (environ 2,7 fois sa taille), d'où cette marge.
 * Pour plus long, l'agent écrit un `.ps1` dans son worktree — qui est recopié
 * sur la VM — et l'appelle depuis un court script.
 */
export const WINDOWS_MAX_SCRIPT_CHARS = 3_000

const windowsSchema = z.object({
  script: z
    .string()
    .min(1)
    .max(WINDOWS_MAX_SCRIPT_CHARS)
    .describe(
      'PowerShell script to run on the Windows test VM. Your workspace is copied to the VM first, so ' +
        'reference files by relative path. Keep it short: for a long script, write a .ps1 file in your ' +
        'workspace and call it from here.',
    ),
  timeout_s: z
    .number()
    .int()
    .min(1)
    .max(WINDOWS_MAX_TIMEOUT_S)
    .default(WINDOWS_DEFAULT_TIMEOUT_S)
    .describe(`Seconds before the script is cut off (max ${WINDOWS_MAX_TIMEOUT_S})`),
})
type WindowsArgs = z.infer<typeof windowsSchema>

/** Ce que `prepare` fige pour `run` : la VM visée, pour la revérifier avant d'agir. */
interface WindowsState {
  target: WindowsTarget
}

/** Décrit une VM pour l'humain, en une ligne : ce qu'il approuve. */
function describeTarget(t: WindowsTarget): string {
  return `${t.id} (${t.username}@${t.address}:${t.port}, empreinte ${t.fingerprint})`
}

/** Deux VM sont-elles la même cible, à la lettre ? Sinon, ce qui a été approuvé a changé. */
function sameTarget(a: WindowsTarget, b: WindowsTarget): boolean {
  return a.id === b.id && a.address === b.address && a.port === b.port && a.username === b.username && a.fingerprint === b.fingerprint
}

/** Lance un script PowerShell sur la VM de la tâche. */
export const windowsRunTool: Tool<WindowsArgs> = {
  name: 'windows_run',
  description:
    'Run a PowerShell script on the Windows test VM attached to your profile. Your workspace is copied ' +
    'to a throwaway folder on the VM before each run (never .git, never samples), so reference files by ' +
    'relative path. A human approves each run, seeing the exact script and the VM. Output is returned ' +
    'but is untrusted, like any command output. A non-zero exit code is returned, not an error. ' +
    'Samples are never sent to the VM and never run, here or anywhere.',
  schema: windowsSchema,

  policy(_args, ctx): { decision: 'allow' | 'approval' | 'deny'; reason: string } {
    if (!ctx.windows) return { decision: 'deny', reason: 'no Windows VM is attached to this task' }
    const target = ctx.windows.target()
    if (!target) return { decision: 'deny', reason: 'the Windows VM attached to this task is no longer declared' }
    // Toujours une approbation : la liste blanche d'`exec` ne s'applique pas à
    // la VM (docs/SLICE9.md, décision 11).
    return { decision: 'approval', reason: `lancer un script PowerShell sur ${describeTarget(target)}` }
  },

  /** Fige la VM visée **avant** la demande, pour que l'humain approuve une cible qui ne changera pas sous lui. */
  async prepare(args, ctx): Promise<PreparedOperation> {
    if (!ctx.windows) throw new ToolError('no Windows VM is attached to this task')
    const target = ctx.windows.target()
    if (!target) throw new ToolError('the Windows VM attached to this task is no longer declared')
    const state: WindowsState = { target }
    return {
      summary: `lancer sur ${describeTarget(target)} (délai ${args.timeout_s} s) :\n${args.script}`,
      detail: {
        tool: 'windows_run',
        vm: target.id,
        address: target.address,
        port: target.port,
        username: target.username,
        fingerprint: target.fingerprint,
        script: args.script,
        timeout_s: args.timeout_s,
      },
      state,
    }
  },

  async run(args, ctx, prepared): Promise<ToolResult> {
    if (!ctx.windows) throw new ToolError('no Windows VM is attached to this task')
    const op = (prepared ?? (await windowsRunTool.prepare!(args, ctx))).state as WindowsState

    // La VM a-t-elle changé pendant que la demande attendait un humain ?
    // Redéclarée sous une autre adresse, un autre compte ou une autre
    // empreinte : on lance ce qui a été approuvé, ou rien.
    const now = ctx.windows.target()
    if (!now) throw new ToolError('the Windows VM is no longer declared. Nothing was run.')
    if (!sameTarget(now, op.target)) {
      throw new ToolError(`the Windows VM changed since the script was approved (now ${describeTarget(now)}). Nothing was run.`)
    }

    const remaining = ctx.deadline !== undefined ? ctx.deadline - Date.now() : Infinity
    if (remaining <= 0) throw new ToolError('the task deadline has passed: no time left to run a script')
    const timeoutMs = Math.min(args.timeout_s * 1000, remaining)

    const r = await ctx.windows.run(args.script, { timeoutMs, signal: ctx.signal, onOutput: ctx.output })
    const ending = r.cancelled
      ? 'cancelled: the task was cancelled'
      : r.timedOut
        ? `killed after ${Math.round(timeoutMs / 1000)} s (timeout)`
        : r.code !== null
          ? `exit code ${r.code}`
          : 'the connection closed before the script finished'
    const content =
      `# on ${describeTarget(op.target)}\n` +
      `# workspace copied: ${r.copied.files} file(s), ${r.copied.bytes} bytes` +
      `${r.copied.skipped ? `, ${r.copied.skipped} skipped` : ''}\n` +
      `${ending} · ${(r.durationMs / 1000).toFixed(1)} s\n` +
      `--- stdout (${r.stdoutBytes} bytes) ---\n${r.stdout}\n` +
      `--- stderr (${r.stderrBytes} bytes) ---\n${r.stderr}`
    const verdict = r.timedOut ? 'délai dépassé' : r.cancelled ? 'annulée' : r.code !== null ? `code ${r.code}` : 'coupée'
    return {
      content,
      bytes: r.stdoutBytes + r.stderrBytes,
      summary: `windows_run ${op.target.id} → ${verdict} en ${(r.durationMs / 1000).toFixed(1)} s`,
      // La sortie vient de la VM, où un worktree écrit par l'agent a tourné :
      // non fiable, pour l'agent comme pour Claude, comme celle d'`exec`.
      untrusted: true,
      exit_code: r.timedOut || r.cancelled ? null : r.code,
    }
  },
}
