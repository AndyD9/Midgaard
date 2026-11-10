/**
 * @file `npm run desktop:bundle` : emballe la coque desktop en une application
 * qu'on lance d'un double-clic — un `.dmg` sous macOS, un installeur `.exe`
 * (NSIS) sous Windows.
 *
 * Ce n'est **pas** une distribution (décision du 2026-11-01, inchangée) :
 * l'application emballée reste la coque de **ce clone**. Elle ne contient ni
 * Node, ni le daemon, ni le dashboard ; son `build.rs` y grave le chemin de
 * `node` et la racine du clone, et elle démarre le daemon par la CLI du clone.
 * Copiée sur une autre machine, elle ne démarre rien. Elle n'est ni signée ni
 * notarisée.
 *
 * `npm run desktop:build` (cargo seul) ne sait pas emballer : c'est la CLI de
 * Tauri (`@tauri-apps/cli`, dépendance de développement) qui le fait. La
 * configuration de base garde `bundle.active: false` ; ce script la recouvre
 * par `tauri.bundle.conf.json`, pour que le build par cargo ne change pas.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Dossier de la coque (`apps/desktop`), où vit ce fichier. */
const here = dirname(fileURLToPath(import.meta.url))
const tauriDir = join(here, 'src-tauri')

/**
 * Format d'emballage par plateforme, et le dossier où Tauri le dépose.
 * Linux n'y est pas : aucun format n'y a été essayé, donc aucun n'est promis.
 */
const TARGETS: Partial<Record<NodeJS.Platform, { bundle: string; dir: string }>> = {
  darwin: { bundle: 'dmg', dir: 'dmg' },
  win32: { bundle: 'nsis', dir: 'nsis' },
}

const target = TARGETS[process.platform]
if (!target) {
  console.error(
    `desktop:bundle ne sait emballer que sous macOS (.dmg) et Windows (.exe) ; ici : ${process.platform}.\n` +
      'La coque se construit et se lance tout de même : npm run desktop:build, puis npm run desktop.',
  )
  process.exit(1)
}

// Le point d'entrée JavaScript de la CLI de Tauri, lancé par le `node` en
// cours : sous Windows, `node_modules/.bin/tauri` est un `.cmd`, qu'on ne
// lance pas sans shell — et un shell relirait les arguments.
let cli: string
try {
  cli = createRequire(import.meta.url).resolve('@tauri-apps/cli/tauri.js')
} catch {
  console.error('La CLI de Tauri est absente : lancer `npm ci` à la racine du clone, puis recommencer.')
  process.exit(1)
}

const result = spawnSync(
  process.execPath,
  [cli, 'build', '--config', join(tauriDir, 'tauri.bundle.conf.json'), '--bundles', target.bundle],
  {
    cwd: tauriDir,
    stdio: 'inherit',
    // `build.rs` grave le `node` de npm (`npm_node_execpath`). On le pose
    // nous-mêmes : le script donne ainsi le même binaire lancé hors de npm.
    env: { ...process.env, npm_node_execpath: process.execPath },
  },
)
if (result.error) {
  console.error(`La CLI de Tauri n'a pas pu démarrer : ${result.error.message}`)
  process.exit(1)
}
if (result.status !== 0) process.exit(result.status ?? 1)

// On ne nomme que ce qui est réellement sur le disque.
const out = join(tauriDir, 'target', 'release', 'bundle', target.dir)
const files = existsSync(out) ? readdirSync(out).filter((f) => /\.(dmg|exe)$/.test(f)) : []
if (files.length === 0) {
  console.error(`Tauri a terminé sans erreur, mais aucun paquet n'est dans ${out}.`)
  process.exit(1)
}
console.log('\nPaquet prêt :')
for (const f of files) console.log(`  ${join(out, f)}`)
console.log(
  "\nL'application reste liée à ce clone et à ce Node : elle démarre le daemon d'ici.\n" +
    'Le dashboard doit être compilé (npm run build). Après une mise à jour du clone ou de Node, relancer desktop:bundle.',
)
