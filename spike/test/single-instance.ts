/**
 * @file Test de l'instance unique du daemon : `npm run test:lock` (environ 30 s).
 *
 * Invariant vérifié : **quel que soit le nombre de daemons lancés en même temps sur
 * un même dossier runtime, un seul survit**, et c'est lui que désigne le fichier
 * de découverte.
 *
 * Ce test existe parce que le scénario S1 de `long-wait.ts` ne suffisait pas : il
 * vérifie que deux clients voient le même daemon, ce qui reste vrai même quand deux
 * daemons tournent (les clients lisent le même fichier de découverte). Une exécution
 * de la suite a ainsi laissé deux daemons actifs sans qu'aucun test n'échoue.
 *
 * Chaque manche lance `CONTENDERS` daemons simultanément, attend `SETTLE_MS`,
 * puis compte les survivants. Deux familles de manches :
 *  - **départ à froid** : dossier vide ;
 *  - **verrou périmé** : un verrou et un fichier de découverte laissés par un daemon
 *    mort (cas d'un `SIGKILL`), que tous les candidats tentent de récupérer en même
 *    temps.
 *
 * Le dossier runtime est isolé dans `.runtime-lock-test/`.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

// Même contrainte que dans long-wait.ts : poser MIDGAARD_HOME avant d'importer shared.ts.
const SPIKE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEST_HOME = join(SPIKE_ROOT, '.runtime-lock-test')
process.env.MIDGAARD_HOME = TEST_HOME
const { DAEMON_ENTRY, LOCK_FILE, RUNTIME_FILE, daemonFetch, readRuntime } = await import('../src/shared.ts')

/** Nombre de daemons lancés simultanément à chaque manche. */
const CONTENDERS = 8
/** Délai laissé aux candidats pour se départager avant de compter les survivants. */
const SETTLE_MS = 2_500
const COLD_ROUNDS = 6
const STALE_ROUNDS = 4

/** Vrai tant que le processus enfant n'est pas terminé. */
const running = (k: ChildProcess) => k.exitCode === null && k.signalCode === null

/**
 * Renvoie le pid d'un processus qui vient de se terminer : un pid réaliste et
 * garanti mort, pour simuler le verrou d'un daemon tué.
 */
async function deadPid(): Promise<number> {
  const p = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await once(p, 'exit')
  return p.pid!
}

/**
 * Joue une manche et renvoie son verdict.
 * @param label   nom affiché
 * @param prepare état à installer dans le dossier runtime avant le départ
 */
async function round(label: string, prepare?: () => Promise<void>) {
  rmSync(TEST_HOME, { recursive: true, force: true })
  mkdirSync(TEST_HOME, { recursive: true, mode: 0o700 })
  await prepare?.()

  const kids = Array.from({ length: CONTENDERS }, () =>
    spawn(process.execPath, [DAEMON_ENTRY], { env: { ...process.env, MIDGAARD_HOME: TEST_HOME }, stdio: 'ignore' }),
  )
  await sleep(SETTLE_MS)

  const alive = kids.filter(running)
  const rt = readRuntime()
  const healthy = rt ? await daemonFetch(rt, '/health').then((r) => r.ok).catch(() => false) : false
  const ok = alive.length === 1 && rt?.pid === alive[0].pid && healthy

  // Nettoyage : arrêt propre du daemon désigné, puis arrêt des survivants en trop
  // (ils n'existent qu'en cas de bug). Ce sont les propres enfants de ce test.
  if (rt && healthy) await daemonFetch(rt, '/shutdown', { method: 'POST' }).catch(() => {})
  await sleep(200)
  for (const k of kids.filter(running)) k.kill('SIGTERM')
  await Promise.all(kids.filter(running).map((k) => once(k, 'exit')))

  const detail = `${alive.length} survivant(s) sur ${CONTENDERS}, découverte → ${rt?.pid ?? 'aucun'}${healthy ? '' : ' (injoignable)'}`
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(18)} ${detail}`)
  return ok
}

const results: boolean[] = []
for (let i = 1; i <= COLD_ROUNDS; i++) results.push(await round(`à froid #${i}`))
for (let i = 1; i <= STALE_ROUNDS; i++) {
  results.push(await round(`verrou périmé #${i}`, async () => {
    const pid = await deadPid()
    writeFileSync(LOCK_FILE, String(pid), { mode: 0o600 })
    writeFileSync(RUNTIME_FILE, JSON.stringify({ pid, port: 1, token: 'x', started_at: new Date().toISOString() }), { mode: 0o600 })
  }))
}

rmSync(TEST_HOME, { recursive: true, force: true })
const failed = results.filter((r) => !r).length
console.log(`\n${results.length} manches, ${failed} échec(s)`)
process.exit(failed ? 1 : 0)
