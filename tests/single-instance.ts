/**
 * @file Instance unique du daemon sous concurrence : `npm run test:lock` (~30 s).
 *
 * Invariant vérifié : **quel que soit le nombre de daemons lancés en même temps
 * sur un même dossier runtime, un seul survit**, et c'est lui que désigne le
 * fichier de découverte.
 *
 * Ce test existe parce qu'un test de bout en bout ne suffisait pas. Celui de la
 * Slice 0 vérifiait que deux clients voient le même daemon — ce qui reste vrai
 * même quand deux daemons tournent, puisque les clients lisent le même fichier de
 * découverte. Deux daemons orphelins ont ainsi survécu à une suite entièrement
 * verte. **Les invariants se testent directement** : ici, en comptant les
 * processus vivants.
 *
 * Deux familles de manches :
 *  - **départ à froid** : dossier vide ;
 *  - **verrou périmé** : un verrou et un fichier de découverte laissés par un
 *    daemon mort (cas d'un `SIGKILL`), que tous les candidats tentent de
 *    récupérer en même temps. C'est la course qui échouait 4 fois sur 4 avant
 *    l'introduction du bail.
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { PROTOCOL_VERSION, daemonFetch, readRuntime } from '@midgaard/contracts'
import { childEnv, deadPid, nodeArgsFor, running, summarize, type Outcome } from './helpers.ts'

/** Nombre de daemons lancés simultanément à chaque manche. */
const CONTENDERS = 8
/** Délai laissé aux candidats pour se départager : au moins deux tours de bail. */
const SETTLE_MS = 2_500
const COLD_ROUNDS = 6
const STALE_ROUNDS = 4

// Le dossier temporaire du système, pas `/tmp` : sous Windows, `/tmp` serait
// `C:\tmp`, hors de ce que le poste de CI nettoie.
const home = join(tmpdir(), 'midgaard-lock-test')
const config = (await import('@midgaard/contracts')).loadConfig({ MIDGAARD_HOME: home, MIDGAARD_PORT: '0' })
const daemonArgs = nodeArgsFor('@midgaard/daemon/main')
const outcomes: Outcome[] = []

/**
 * Joue une manche et rend son verdict.
 * @param label   nom affiché
 * @param prepare état à installer dans le dossier runtime avant le départ
 */
async function round(label: string, prepare?: () => Promise<void>): Promise<void> {
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true, mode: 0o700 })
  await prepare?.()

  const kids = Array.from({ length: CONTENDERS }, () =>
    spawn(process.execPath, daemonArgs, { env: childEnv(home), stdio: 'ignore' }),
  )
  await sleep(SETTLE_MS)

  const alive = kids.filter(running)
  const rt = readRuntime(config.runtimeFile)
  const healthy = rt ? await daemonFetch(rt, '/api/health').then((r) => r.ok).catch(() => false) : false
  const ok = alive.length === 1 && rt?.pid === alive[0]!.pid && healthy

  // Nettoyage : arrêt propre du daemon désigné, puis des survivants en trop
  // (ils n'existent qu'en cas de bug). Ce sont les propres enfants de ce test.
  if (rt && healthy) await daemonFetch(rt, '/api/shutdown', { method: 'POST' }).catch(() => {})
  await sleep(200)
  for (const k of kids.filter(running)) k.kill('SIGTERM')
  await Promise.all(kids.filter(running).map((k) => once(k, 'exit')))

  outcomes.push({
    name: label,
    verdict: ok ? 'PASS' : 'FAIL',
    detail:
      `${alive.length} survivant(s) sur ${CONTENDERS}, ` +
      `découverte → ${rt?.pid ?? 'aucun'}${healthy ? '' : ' (injoignable)'}`,
  })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(20)} ${outcomes[outcomes.length - 1]!.detail}`)
}

console.log(`Instance unique : ${CONTENDERS} daemons par manche, ${COLD_ROUNDS + STALE_ROUNDS} manches\n`)
for (let i = 1; i <= COLD_ROUNDS; i++) await round(`à froid #${i}`)
for (let i = 1; i <= STALE_ROUNDS; i++) {
  await round(`verrou périmé #${i}`, async () => {
    const pid = await deadPid()
    writeFileSync(config.lockFile, String(pid), { mode: 0o600 })
    writeFileSync(
      config.runtimeFile,
      JSON.stringify({
        pid,
        port: 1,
        token: 'x'.repeat(64),
        started_at: new Date().toISOString(),
        protocol: PROTOCOL_VERSION,
        dashboard_url: 'http://127.0.0.1:1/',
      }),
      { mode: 0o600 },
    )
  })
}

rmSync(home, { recursive: true, force: true })
process.exit(summarize(outcomes, 'Résumé — instance unique'))
