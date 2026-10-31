/**
 * @file Contrôles de la publication npm, lancés par `.github/workflows/publish.yml`.
 *
 * Un paquet publié ne se reprend pas : une version parue ne se republie jamais
 * sous le même numéro. Tout ce qui peut faire échouer la publication est donc
 * vérifié **avant**, et ce qui a été publié est comparé **après** à ce qui a
 * été éprouvé. Les contrôles vivent ici plutôt qu'en shell dans le workflow
 * pour se lancer tels quels sur un poste, et y échouer de la même façon.
 *
 * ```bash
 * node scripts/release.ts check                 # avant : version, registre, branche
 * node scripts/release.ts published <tarball>   # après : le registre sert-il ce tarball ?
 * ```
 *
 * `check` lit `GITHUB_REF_TYPE` et `GITHUB_REF_NAME` : sur un tag, il exige que
 * le tag soit `v` + la version du `package.json`. Sans tag (répétition générale
 * lancée à la main, ou un poste), il ne contrôle que le reste.
 *
 * Code de sortie : `0` si tout tient, `1` sinon, chaque refus dit pourquoi.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE = 'midgaard'
const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version

/**
 * Version minimale de npm pour la publication de confiance (OIDC), d'après la
 * documentation npm « Trusted publishing », relue le 2026-10-31.
 */
const MIN_NPM: readonly [number, number, number] = [11, 5, 1]

/** `npm`, sans shell sauf sous Windows, où `npm` est un script `.cmd`. */
function npm(args: string[]) {
  return spawnSync('npm', args, { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' })
}

/**
 * Empreinte d'un tarball au format de `dist.integrity` sur le registre :
 * `sha512-` suivi du condensé en base64 (Subresource Integrity).
 *
 * @param tarball chemin du `.tgz`
 */
export function integrity(tarball: string): string {
  return `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`
}

/**
 * Compare deux versions `x.y.z` (suffixe de préversion ignoré).
 *
 * @returns vrai si `actual` est au moins `min`
 */
export function atLeast(actual: string, min: readonly [number, number, number]): boolean {
  const parts = actual.split('-')[0]!.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const a = parts[i] ?? 0
    if (a !== min[i]) return a > min[i]!
  }
  return true
}

/** Avant la publication : tout ce qui la ferait échouer, ou publier ce qu'il ne faut pas. */
function check(): number {
  const refusals: string[] = []
  const ok = (label: string) => console.log(`✔ ${label}`)

  // 1. Le tag dit la version : un `v0.2.0` qui publierait un `0.1.0` (ou
  //    l'inverse) laisserait le dépôt et le registre se contredire.
  if (process.env.GITHUB_REF_TYPE === 'tag') {
    const tag = process.env.GITHUB_REF_NAME ?? ''
    if (tag !== `v${version}`) refusals.push(`le tag ${tag} ne correspond pas à la version du package.json (${version}) : attendu v${version}`)
    else ok(`tag ${tag} = version ${version}`)
  } else {
    ok(`pas de tag : répétition générale de la version ${version}`)
  }

  // 2. La version n'existe pas encore sur le registre. npm refuserait de toute
  //    façon, mais après un quart d'heure de tests sur trois machines ; et
  //    surtout, un 404 sur le **paquet** est le cas normal avant la toute
  //    première publication, à distinguer d'une erreur réseau.
  const view = npm(['view', `${PACKAGE}@${version}`, 'version', '--json'])
  if (view.status === 0 && view.stdout.trim()) {
    refusals.push(`${PACKAGE}@${version} est déjà publié : une version publiée ne se republie pas, augmente la version`)
  } else if (view.status !== 0 && !/E404|404 Not Found/.test(view.stderr)) {
    refusals.push(`registre injoignable, impossible de savoir si ${PACKAGE}@${version} existe :\n${view.stderr.trim()}`)
  } else {
    ok(`${PACKAGE}@${version} absent du registre`)
  }

  // 3. On ne publie que ce qui est sur main : un tag posé sur une branche de
  //    travail publierait du code qu'aucune revue ni aucune CI de main n'a vu.
  const sha = process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const onMain = spawnSync('git', ['merge-base', '--is-ancestor', sha, 'origin/main'], { cwd: root })
  if (onMain.status === 0) ok(`commit ${sha.slice(0, 7)} présent sur origin/main`)
  else refusals.push(`le commit ${sha.slice(0, 7)} n'est pas sur origin/main (ou origin/main n'a pas été récupéré)`)

  // 4. npm sait faire la publication de confiance. En dessous, il ignore
  //    l'OIDC sans le dire et échoue en E404 ou ENEEDAUTH.
  const npmVersion = npm(['--version']).stdout.trim()
  if (atLeast(npmVersion, MIN_NPM)) ok(`npm ${npmVersion} (minimum ${MIN_NPM.join('.')})`)
  else refusals.push(`npm ${npmVersion} est trop ancien pour la publication de confiance (minimum ${MIN_NPM.join('.')})`)

  for (const r of refusals) console.error(`✘ ${r}`)
  return refusals.length ? 1 : 0
}

/**
 * Après la publication : le registre sert-il exactement le tarball éprouvé ?
 * Il lui faut parfois quelques secondes pour exposer une version neuve, d'où
 * l'attente bornée.
 */
async function published(tarball: string): Promise<number> {
  const local = integrity(tarball)
  for (let attempt = 1; attempt <= 12; attempt++) {
    const view = npm(['view', `${PACKAGE}@${version}`, 'dist.integrity'])
    const remote = view.stdout.trim()
    if (remote) {
      if (remote === local) {
        console.log(`✔ le registre sert le tarball éprouvé : ${local}`)
        return 0
      }
      console.error(`✘ le registre sert un autre tarball que celui qui a été éprouvé\n  local    ${local}\n  registre ${remote}`)
      return 1
    }
    await sleep(5_000)
  }
  console.error(`✘ ${PACKAGE}@${version} toujours introuvable sur le registre après une minute`)
  return 1
}

if (import.meta.main) {
  const [command, arg] = process.argv.slice(2)
  if (command === 'check') process.exitCode = check()
  else if (command === 'published' && arg) process.exitCode = await published(arg)
  else if (command === 'integrity' && arg) console.log(integrity(arg))
  else {
    console.error('usage : node scripts/release.ts check | published <tarball> | integrity <tarball>')
    process.exitCode = 1
  }
}
