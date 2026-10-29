/**
 * @file Mise en forme du terminal.
 *
 * Les couleurs ne sont émises que si la sortie est un terminal et que
 * `NO_COLOR` est absent : la sortie de `harness status` doit rester lisible
 * quand elle est redirigée dans un fichier ou un tube.
 */
const enabled = process.stdout.isTTY === true && !process.env.NO_COLOR

const wrap = (code: string) => (s: string) => (enabled ? `\u001b[${code}m${s}\u001b[0m` : s)

export const bold = wrap('1')
export const dim = wrap('2')
export const red = wrap('31')
export const green = wrap('32')
export const yellow = wrap('33')
export const blue = wrap('36')

/** Pastille d'état d'un contrôle de `doctor`. */
export const mark = { ok: () => green('✔'), warn: () => yellow('!'), fail: () => red('✘') }

/** Couleur associée à un statut de tâche : vert si tout va bien, jaune si ça attend, rouge sinon. */
export function colorStatus(status: string): string {
  if (status === 'completed') return green(status)
  if (status === 'waiting_approval' || status === 'cancel_requested') return yellow(status)
  if (['failed', 'cancelled', 'timed_out', 'budget_exceeded', 'interrupted'].includes(status)) return red(status)
  return blue(status)
}

/** Durée lisible : `1,4 s`, `3 min 12 s`. */
export function humanDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace('.', ',')} s`
  const min = Math.floor(ms / 60_000)
  return `${min} min ${Math.round((ms % 60_000) / 1000)} s`
}
