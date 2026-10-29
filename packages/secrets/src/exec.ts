/**
 * @file Lancement des utilitaires système, avec les précautions qui vont avec.
 *
 * Trois règles, toutes issues de §5 du plan :
 *
 *  1. **`execFile`, jamais `exec`.** Aucun shell n'est interposé, donc aucun
 *     `;`, `|` ou `$()` d'un argument ne peut devenir une commande.
 *  2. **Environnement reconstruit.** Les utilitaires reçoivent le strict
 *     nécessaire, jamais `process.env` hérité : une variable `PATH` détournée
 *     suffirait à faire exécuter autre chose que `security`.
 *  3. **Délai et terminaison.** Un utilitaire qui attend une saisie bloquerait
 *     le daemon ; il est tué au bout de {@link EXEC_TIMEOUT_MS}.
 *
 * Le secret, lui, passe par **stdin** partout où c'est possible. Reste le cas de
 * `security` sur macOS, qui n'accepte un mot de passe qu'en argument : il est
 * alors visible dans `ps` pour les processus **du même utilisateur**, ce que le
 * modèle de menace du harness place déjà hors périmètre (voir
 * `packages/daemon/README.md`). C'est dit, pas caché.
 */
import { execFile } from 'node:child_process'

/** Délai au-delà duquel un utilitaire est considéré bloqué. */
export const EXEC_TIMEOUT_MS = 10_000

/** Sortie d'un utilitaire. `code` vaut `null` s'il a été tué par un signal. */
export interface ExecOutcome {
  code: number | null
  stdout: string
  stderr: string
}

/**
 * Lance un utilitaire et attend sa fin.
 *
 * Ne **lève pas** sur un code de sortie non nul : un `find-generic-password` qui
 * ne trouve rien sort en 44, ce qui est une réponse, pas une panne. L'appelant
 * interprète le code.
 *
 * @param file     binaire à lancer, résolu via le `PATH` reconstruit
 * @param args     arguments, passés tels quels sans interprétation shell
 * @param stdin    donnée à écrire sur l'entrée standard, par exemple un secret
 * @param extraEnv variables ajoutées à {@link minimalEnv} pour ce seul appel.
 *                 C'est ainsi qu'une donnée variable atteint un script sans être
 *                 concaténée à son code — voir le coffre DPAPI. Écrire dans
 *                 `process.env` ne marcherait pas : l'environnement du fils est
 *                 reconstruit, et deux appels concurrents se marcheraient dessus.
 */
export function run(
  file: string,
  args: string[],
  stdin?: string,
  extraEnv?: NodeJS.ProcessEnv,
): Promise<ExecOutcome> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        timeout: EXEC_TIMEOUT_MS,
        // Un secret peut faire quelques kilo-octets ; une liste de modèles, plus.
        maxBuffer: 1024 * 1024,
        env: { ...minimalEnv(), ...extraEnv },
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const err = error as (NodeJS.ErrnoException & { code?: number | string }) | null
        // ENOENT : le binaire n'existe pas sur cette machine. C'est le cas
        // nominal quand on sonde les coffres pour savoir lequel est utilisable.
        if (err && (err.code === 'ENOENT' || err.code === 'EACCES')) return reject(err)
        resolve({
          code: typeof err?.code === 'number' ? err.code : err ? 1 : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        })
      },
    )
    child.on('error', reject)
    if (stdin !== undefined) {
      child.stdin?.end(stdin)
    }
  })
}

/**
 * Environnement minimal des utilitaires.
 *
 * Ce qui est repris l'est pour une raison nommée, et rien d'autre ne passe :
 * ajouter une variable ici, c'est l'exposer à trois utilitaires système.
 *
 * `PATH` est repris pour que `security`, `secret-tool` et `powershell` restent
 * trouvables — les remplacer par des chemins absolus en dur casserait les
 * installations non standard, et un `PATH` détourné suppose déjà un attaquant
 * dans la session de l'utilisateur, donc déjà vainqueur. `HOME`, `USERPROFILE`
 * et `LOCALAPPDATA` sont nécessaires pour que chaque mécanisme trouve son
 * propre magasin.
 */
function minimalEnv(): NodeJS.ProcessEnv {
  const keep = [
    'PATH', 'Path',
    'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'SystemRoot', 'TEMP', 'TMP',
    // `secret-tool` ne parle pas au trousseau directement : il passe par le bus
    // de session. Sans ces deux variables il ne le trouve pas, échoue sur une
    // machine où le trousseau fonctionne pourtant, et le harness se rabat sur
    // le fichier en croyant qu'il n'y a pas de trousseau.
    'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR',
  ]
  const env: NodeJS.ProcessEnv = { LC_ALL: 'C' }
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k]
  return env
}
