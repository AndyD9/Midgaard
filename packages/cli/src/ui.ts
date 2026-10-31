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

/**
 * Vrai quand la CLI tourne depuis les sources du dépôt (`src/*.ts`), faux
 * depuis le paquet installé (`dist/*.js`).
 */
const fromSources = import.meta.url.endsWith('.ts')

/**
 * Une commande `harness` telle que l'utilisateur peut la taper.
 *
 * Installé depuis npm, le binaire `harness` est dans le `PATH`. Depuis les
 * sources, il ne l'est pas : la commande passe par npm. Les conseils de
 * `doctor` disaient `npm run harness -- …` à tout le monde — une commande qui
 * n'existe pas chez qui a installé le paquet (constaté en l'installant dans un
 * préfixe vierge, docs/SLICE4.md, étape 6).
 *
 * @param args la commande, sans `harness`, par exemple `providers add venice`
 */
export function cmd(args: string): string {
  return fromSources ? `npm run harness -- ${args}` : `harness ${args}`
}

/**
 * Que faire quand le dashboard compilé manque. Depuis les sources, le compiler ;
 * dans le paquet installé, il fait partie du paquet : son absence dit une
 * installation abîmée.
 */
export const buildAdvice = fromSources ? 'npm run build' : 'npm install -g midgaard   # le paquet installé est incomplet'
