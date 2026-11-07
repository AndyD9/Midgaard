/**
 * @file Garde d'`exec` contre l'exécution d'un échantillon (Slice 9, étape 4).
 *
 * Un échantillon ne s'exécute **jamais**, même avec approbation (décision prise
 * avec l'auteur). La garde est donc un **refus**, posé dans `prepare` : aucun
 * humain n'est sollicité pour une commande qu'il n'aurait pas le droit
 * d'accorder.
 *
 * Un fichier « est un échantillon » s'il se trouve sous le dossier des copies,
 * ou s'il a **le même contenu** que l'une d'elles (taille, puis SHA-256) :
 * `cp sample ./x` puis `./x` est la même exécution. Sont refusés :
 *
 *  1. un programme qui est un échantillon ;
 *  2. un **chargeur, émulateur, débogueur ou traceur** (`wine`, `mono`,
 *     `rundll32`, `qemu-*`, `floss`, `speakeasy`, `gdb`, `strace`…) dont un
 *     argument est un échantillon : chacun le fait tourner, ou tourner sa
 *     logique ;
 *  3. un **shell**, ou un interpréteur autre que Python, dont un argument est
 *     un échantillon : `bash -c '"$0"' sample`, `node -r sample.js` — leurs
 *     options qui chargent du code sont trop nombreuses pour être lues sûrement ;
 *  4. **Python** quand l'échantillon est à la place du script
 *     (`python sample.py`), ou passé à un module qui exécute ou émule
 *     (`python -m runpy|pdb|floss|speakeasy|qiling …`). `python analyze.py
 *     sample.exe` reste permis : c'est l'usage même d'un script d'analyse.
 *
 * Ce que la garde ne prétend pas : voir dans le code d'un script ce qu'il fait
 * du fichier qu'il lit (`exec(open(sample).read())`), ni reconnaître une copie
 * modifiée d'un octet. Là, l'approbation reste la frontière ; l'humain lit le
 * script et la commande.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { INTERPRETER_FAMILIES, programFamily, PYTHON_FAMILIES, SHELL_FAMILIES } from '@midgaard/contracts'
import type { ToolContext } from './types.ts'

/** Ce que la garde reçoit : les échantillons de la tâche. */
export type SamplesContext = NonNullable<ToolContext['samples']>

/**
 * Programmes qui font tourner, émulent ou tracent le fichier qu'on leur donne.
 * Familles au sens de `programFamily` (`wine64` → `wine`, `rundll32` → `rundll`).
 */
const LOADERS = new Set([
  'wine', 'wine-preloader', 'mono', 'dotnet', 'java', 'javaw', 'rundll', 'regsvr', 'msiexec', 'mshta', 'cscript',
  'wscript', 'open', 'xdg-open', 'start', 'box', 'floss', 'speakeasy', 'qltool', 'frida', 'gdb', 'lldb', 'windbg',
  'cdb', 'x64dbg', 'x32dbg', 'strace', 'ltrace', 'valgrind', 'rr', 'deno', 'bun',
])

/** Modules Python qui exécutent, déboguent ou émulent le fichier qu'on leur passe. */
const RUNNING_MODULES = new Set([
  'runpy', 'pdb', 'trace', 'cProfile', 'profile', 'floss', 'speakeasy', 'qiling', 'unicorn', 'frida',
])

/** Options de Python qui prennent une valeur : elle n'est pas le script. */
const PYTHON_VALUE_OPTIONS = new Set(['-W', '-X', '-Q'])

/** SHA-256 d'un fichier, lu en flux. */
function sha256(path: string): Promise<string> {
  return new Promise((done, fail) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (c) => hash.update(c))
      .on('error', fail)
      .on('end', () => done(hash.digest('hex')))
  })
}

/**
 * Nom de l'échantillon que désigne `path`, ou `null`. Un chemin qui n'existe
 * pas, ou qui n'est pas un fichier, n'en est pas un. L'empreinte n'est
 * calculée que si la taille correspond : la garde passe sur chaque argument.
 */
async function sampleAt(path: string, samples: SamplesContext): Promise<string | null> {
  const real = await realpath(path).catch(() => null)
  if (!real) return null
  const rel = relative(samples.dir, real)
  if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) {
    return samples.files.find((f) => f.path === real)?.name ?? rel
  }
  const st = await stat(real).catch(() => null)
  if (!st?.isFile()) return null
  const sameSize = samples.files.filter((f) => f.bytes === st.size)
  if (sameSize.length === 0) return null
  const sha = await sha256(real).catch(() => null)
  return sameSize.find((f) => f.sha256 === sha)?.name ?? null
}

/**
 * Dit si une commande ferait tourner un échantillon, et lequel.
 *
 * @param file programme résolu (chemin absolu)
 * @param args arguments, tels que l'agent les a écrits
 * @param cwd  dossier de la commande, contre lequel un argument relatif se lit
 * @returns le motif du refus, en anglais (le modèle le lit), ou `null`
 */
export async function sampleExecRefusal(
  file: string,
  args: readonly string[],
  cwd: string,
  samples: SamplesContext | undefined,
): Promise<string | null> {
  if (!samples || samples.files.length === 0) return null
  const never = 'Samples are never executed, loaded or emulated, even with approval: analyse them statically.'

  const program = await sampleAt(file, samples)
  if (program) return `refused: the program is the sample ${program} (or an identical copy). ${never}`

  // Chaque argument qui désigne un fichier existant est comparé : un chemin
  // absolu, ou relatif au dossier de la commande.
  const hits: { index: number; name: string }[] = []
  for (const [index, arg] of args.entries()) {
    if (arg.length === 0 || arg.startsWith('-')) continue
    // `--opt=valeur` est sauté ci-dessus ; une valeur collée (`-rsample.js`) aussi.
    const name = await sampleAt(isAbsolute(arg) ? arg : resolve(cwd, arg), samples)
    if (name) hits.push({ index, name })
  }
  if (hits.length === 0) return null

  const family = programFamily(file)
  const first = hits[0]!.name
  if (LOADERS.has(family) || family.startsWith('qemu')) {
    return `refused: ${family} would run, load or emulate the sample ${first}. ${never}`
  }
  if (SHELL_FAMILIES.has(family) || INTERPRETER_FAMILIES.has(family)) {
    return (
      `refused: ${family} is given the sample ${first}, and could run it. ${never} ` +
      'To analyse it with code, write a Python script and pass the sample to it as an argument.'
    )
  }
  if (PYTHON_FAMILIES.has(family)) {
    // Le script est le premier argument qui n'est ni une option ni la valeur
    // d'une option ; `-m` et `-c` en tiennent lieu.
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!
      if (a === '-c') return null
      if (a === '-m') {
        const module = (args[i + 1] ?? '').split('.')[0]!
        return RUNNING_MODULES.has(module)
          ? `refused: python -m ${module} would run or emulate the sample ${first}. ${never}`
          : null
      }
      if (PYTHON_VALUE_OPTIONS.has(a)) {
        i++
        continue
      }
      if (a.startsWith('-')) continue
      const script = hits.find((h) => h.index === i)
      return script ? `refused: python would run the sample ${script.name} as its script. ${never}` : null
    }
  }
  return null
}
