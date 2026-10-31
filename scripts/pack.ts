/**
 * @file Assemblage du paquet npm `midgaard` : `npm run pack:npm`.
 *
 * Décision de la Slice 4 : **un seul paquet**, qui embarque les dix paquets du
 * workspace ; ceux-ci restent privés. Un tarball unique ne peut pas se
 * désaccorder avec lui-même — dix paquets publiés séparément pourraient
 * s'installer en versions mêlées (docs/SLICE4.md).
 *
 * ## Comment, sans outil de plus
 *
 * Le dossier `.pack/midgaard/` est construit **tel que npm l'installera** : les
 * paquets internes sont rangés dans son `node_modules/@midgaard/`, et déclarés
 * en `bundleDependencies`. npm les emporte dans le tarball et les déballe à la
 * même place chez qui installe. Rien n'est réécrit dans le code : les imports
 * `@midgaard/…` et les `import.meta.resolve('@midgaard/daemon/main')` résolvent
 * comme dans le dépôt, vers `dist/` puisque la condition `midgaard-dev` n'y
 * est jamais posée.
 *
 * Les dépendances externes (`zod`, `ws`, le SDK MCP) sont déclarées par le
 * paquet de tête **seul**, et npm les installe à côté ; les paquets internes
 * les trouvent en remontant l'arborescence. Les déclarer aussi dans les paquets
 * internes ne marche pas : npm tient les dépendances d'un paquet embarqué pour
 * embarquées elles aussi, ne les télécharge pas, et laisse un dossier vide —
 * constaté au premier essai, `node_modules/zod` vide. Elles sont épinglées aux
 * versions **exactes** du `package-lock.json` : celles que les suites ont
 * éprouvées, pas la dernière parue le jour de l'installation.
 *
 * ## Ce que l'assemblage vérifie, parce qu'un paquet publié ne se reprend pas
 *
 *  - il part d'un **build propre** : `tsc -b` ne retire jamais la sortie d'une
 *    source supprimée, et un vieux `.js` orphelin partirait avec le reste ;
 *  - chaque export réécrit désigne un fichier **présent** dans le paquet ;
 *  - chaque dépendance externe a une version dans le `package-lock.json` ;
 *  - rien d'autre que du `.js`, les fichiers déclarés (`files`), les README et
 *    la licence : ni sources, ni `.d.ts`, ni cartes de sources qui pointeraient
 *    vers des sources absentes ;
 *  - le README du paquet, `docs/INSTALLER.md`, ne renvoie ni vers le dépôt par
 *    un lien relatif, ni vers une commande `npm run` qui n'existe que dans un
 *    clone.
 *
 * La sortie dit le nom du tarball, sa taille et son nombre de fichiers.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, '.pack')
const stage = join(out, 'midgaard')

/** Le manifeste d'un paquet du workspace, dans ce qu'on en lit. */
interface Manifest {
  name: string
  version: string
  description?: string
  exports: Record<string, string | Record<string, string>>
  dependencies?: Record<string, string>
  files?: string[]
}

const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  version: string
  description: string
  license: string
  repository: unknown
  engines: Record<string, string>
}
const version = rootManifest.version
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as {
  packages: Record<string, { version?: string }>
}

/** `npm`, lancé sans shell sauf sous Windows, où `npm` est un script `.cmd`. */
function npm(args: string[], cwd: string): string {
  return execFileSync('npm', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' })
}

/** Copie récursivement les seuls `.js` d'un dossier. */
function copyJs(from: string, to: string): number {
  let n = 0
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    if (entry.isDirectory()) n += copyJs(source, join(to, entry.name))
    else if (entry.name.endsWith('.js')) {
      mkdirSync(to, { recursive: true })
      cpSync(source, join(to, entry.name))
      n++
    }
  }
  return n
}

/**
 * Exports du paquet publié : la cible `default` de chaque entrée, seule. La
 * condition `midgaard-dev` (sources) et `types` (sources aussi) n'ont rien à
 * désigner dans un paquet qui ne contient que `dist/`.
 */
function publishedExports(manifest: Manifest, dir: string): Record<string, string> {
  const exports: Record<string, string> = {}
  for (const [key, target] of Object.entries(manifest.exports)) {
    const path = typeof target === 'string' ? target : target.default
    if (!path) throw new Error(`${manifest.name} : l'export « ${key} » n'a pas de cible « default »`)
    if (!existsSync(join(dir, path))) throw new Error(`${manifest.name} : l'export « ${key} » désigne ${path}, absent du paquet`)
    exports[key] = path
  }
  return exports
}

// --- 1. Build propre --------------------------------------------------------

console.log('Build propre…')
npm(['run', 'clean'], root)
npm(['run', 'build'], root)

// --- 2. Paquets internes ----------------------------------------------------

rmSync(out, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })

const internal: string[] = []
const external: Record<string, string> = {}
for (const dir of readdirSync(join(root, 'packages'))) {
  const source = join(root, 'packages', dir)
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as Manifest
  const target = join(stage, 'node_modules', manifest.name)

  const files = copyJs(join(source, 'dist'), join(target, 'dist'))
  for (const extra of manifest.files ?? []) {
    if (extra === 'dist') continue
    cpSync(join(source, extra), join(target, extra), { recursive: true })
  }
  if (existsSync(join(source, 'README.md'))) cpSync(join(source, 'README.md'), join(target, 'README.md'))

  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (name.startsWith('@midgaard/')) continue
    const locked = lock.packages[`node_modules/${name}`]?.version
    if (!locked) throw new Error(`${name} (demandé par ${manifest.name}) n'a pas de version dans package-lock.json`)
    external[name] = locked
  }
  writeFileSync(
    join(target, 'package.json'),
    JSON.stringify(
      {
        name: manifest.name,
        // La version publiée, partout : la CLI la lit dans son propre manifeste.
        version,
        description: manifest.description,
        private: true,
        type: 'module',
        exports: publishedExports(manifest, target),
        // Aucune dépendance déclarée ici : voir l'en-tête.
      },
      null,
      2,
    ) + '\n',
  )
  internal.push(manifest.name)
  console.log(`  ${manifest.name.padEnd(24)} ${files} fichier(s) .js`)
}

// --- 3. Le dashboard, à côté du daemon --------------------------------------

// `defaultDashboardDir` le cherche là d'abord : `apps/` n'existe pas chez qui
// installe depuis npm.
const dashboard = join(root, 'apps', 'dashboard', 'dist')
if (!existsSync(join(dashboard, 'index.html'))) throw new Error('dashboard non compilé : rien à embarquer')
// Sans ses cartes de sources : Vite en produit, et elles ne servent qu'au
// développement — la vérification de l'étape 5 les a trouvées au premier essai.
cpSync(dashboard, join(stage, 'node_modules', '@midgaard', 'daemon', 'dashboard'), {
  recursive: true,
  filter: (path) => !path.endsWith('.map'),
})

// --- 4. Le paquet de tête ---------------------------------------------------

mkdirSync(join(stage, 'bin'))
const bin = join(stage, 'bin', 'harness.js')
writeFileSync(
  bin,
  [
    '#!/usr/bin/env node',
    '// Binaire `harness` du paquet midgaard : la CLI embarquée fait tout le travail.',
    "import '@midgaard/cli/main'",
    '',
  ].join('\n'),
)
chmodSync(bin, 0o755)

writeFileSync(
  join(stage, 'package.json'),
  JSON.stringify(
    {
      name: 'midgaard',
      version,
      description: rootManifest.description,
      license: rootManifest.license,
      repository: rootManifest.repository,
      type: 'module',
      engines: rootManifest.engines,
      bin: { harness: 'bin/harness.js' },
      // Les paquets internes figurent dans `dependencies` **et** dans
      // `bundleDependencies` : c'est ainsi que npm les emporte au lieu de les
      // chercher sur le registre, où ils n'existent pas.
      dependencies: { ...external, ...Object.fromEntries(internal.map((n) => [n, version])) },
      bundleDependencies: internal,
    },
    null,
    2,
  ) + '\n',
)
// Le README du paquet n'est pas celui du dépôt : celui-ci s'adresse à qui
// clone, avec ses `npm run harness -- …` et ses liens relatifs vers `docs/`.
// Sur npmjs.com, ni les uns ni les autres ne mènent nulle part (Slice 4,
// étape 7). `docs/INSTALLER.md` est écrit pour qui installe, et l'assemblage
// refuse qu'il redevienne un README de clone.
const readme = readFileSync(join(root, 'docs', 'INSTALLER.md'), 'utf8')
const relativeLinks = [...readme.matchAll(/\]\((?!https:\/\/|#)([^)]*)\)/g)].map((m) => m[1])
if (relativeLinks.length) throw new Error(`docs/INSTALLER.md : liens relatifs, morts sur npmjs.com : ${relativeLinks.join(', ')}`)
if (/npm run /.test(readme)) throw new Error('docs/INSTALLER.md conseille « npm run … », qui n\'existe que dans un clone')
writeFileSync(join(stage, 'README.md'), readme)
cpSync(join(root, 'LICENSE'), join(stage, 'LICENSE'))

// --- 5. Le tarball ----------------------------------------------------------

const [packed] = JSON.parse(npm(['pack', '--json', '--pack-destination', out], stage)) as {
  filename: string
  size: number
  unpackedSize: number
  files: { path: string }[]
}[]
const forbidden = packed!.files.filter((f) => /(^|\/)src\/|\.d\.ts$|\.map$|\.tsbuildinfo$|(^|\/)\.mcp\.json$/.test(f.path))
if (forbidden.length) throw new Error(`fichiers qui n'ont rien à faire dans le paquet : ${forbidden.map((f) => f.path).join(', ')}`)
console.log(
  `\n${relative(root, join(out, packed!.filename))} — ${(packed!.size / 1024).toFixed(0)} Kio compressés, ` +
    `${(packed!.unpackedSize / 1024).toFixed(0)} Kio déballés, ${packed!.files.length} fichiers`,
)
