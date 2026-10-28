/**
 * @file Suite de bout en bout du spike : `npm run test:wait` (environ 100 s).
 *
 * Exerce le serveur MCP avec le client officiel du SDK, via stdio — le même
 * protocole que Claude Code. Rien n'est simulé côté serveur : les vrais processus
 * (serveur MCP, daemon) sont lancés.
 *
 * Scénarios :
 *  - S1 deux clients simultanés sans daemon → un seul daemon démarre ;
 *  - S2 aucun outil d'approbation n'est exposé à Claude ;
 *  - S3 l'attente rend la main sur une approbation, puis aboutit après celle-ci ;
 *  - S4 interrompre l'attente ne coupe pas la tâche, `cancel` oui ;
 *  - S5 attente de 90 s **sans** progression : mesure où le client coupe ;
 *  - S6 attente de 90 s **avec** progression : doit tenir jusqu'au bout ;
 *  - S7 daemon tué en cours de session → relancé au prochain appel ;
 *  - S8 consignes d'approbation exactes, sans renvoi vers un dashboard inexistant
 *    (défaut n° 1 du test réel) ;
 *  - S9 une pause déjà signalée fait bloquer l'attente jusqu'à la décision humaine,
 *    tandis qu'un client qui ne l'a jamais vue est prévenu aussitôt (défaut n° 2) ;
 *  - S10 un daemon d'une version antérieure, resté actif après une mise à jour du
 *    code, est remplacé au premier appel.
 *
 * Verdicts : `PASS`/`FAIL` pour les comportements garantis ; `CONSTAT` pour une
 * mesure d'environnement qui n'engage pas notre code (S5 documente une limite du
 * client, il ne peut pas échouer). Code de sortie 1 s'il y a au moins un `FAIL`.
 *
 * Le runtime est isolé dans `.runtime-test/`, sans toucher au daemon de
 * développement (`.runtime/`).
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'

// shared.ts fige ses chemins à l'évaluation : MIDGAARD_HOME doit être posé avant son
// premier import, d'où l'import dynamique (un import statique serait hissé avant).
const SPIKE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEST_HOME = join(SPIKE_ROOT, '.runtime-test')
process.env.MIDGAARD_HOME = TEST_HOME
const { PROTOCOL_VERSION, daemonFetch, pidAlive, readRuntime } = await import('../src/shared.ts')

/** Résultat d'un scénario, affiché au fil de l'eau puis dans le résumé final. */
type Outcome = { name: string; verdict: 'PASS' | 'FAIL' | 'CONSTAT'; detail: string }
const outcomes: Outcome[] = []
const t0 = Date.now()
/** Temps écoulé depuis le début de la suite, pour horodater la sortie. */
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`
const say = (m: string) => console.log(`[${at()}] ${m}`)

/**
 * Lance un serveur MCP (processus réel) et y connecte un client.
 * `getDefaultEnvironment()` reproduit l'environnement minimal que le SDK transmet
 * aux serveurs stdio ; on y ajoute seulement le dossier runtime de test.
 */
async function connect(name: string): Promise<Client> {
  const client = new Client({ name, version: '0' })
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [join(SPIKE_ROOT, 'src', 'mcp-server.ts')],
    env: { ...getDefaultEnvironment(), MIDGAARD_HOME: TEST_HOME },
    stderr: 'ignore',
  }))
  return client
}

/**
 * Extrait la réponse d'un appel d'outil : le JSON renvoyé par le serveur, plus
 * `isError`. Si le texte n'est pas du JSON (message d'erreur), il va dans `message`.
 */
function payload(res: unknown): Record<string, any> {
  const r = res as { content: { text: string }[]; isError?: boolean }
  const text = r.content[0]?.text ?? ''
  try {
    return { ...JSON.parse(text), isError: r.isError }
  } catch {
    return { message: text, isError: r.isError }
  }
}

/**
 * Exécute un scénario et enregistre son verdict. Une exception compte comme un
 * `FAIL` avec son message : un scénario ne fait jamais tomber toute la suite.
 */
async function scenario(name: string, fn: () => Promise<Omit<Outcome, 'name'>>): Promise<void> {
  say(`▶ ${name}`)
  try {
    outcomes.push({ name, ...(await fn()) })
  } catch (e) {
    outcomes.push({ name, verdict: 'FAIL', detail: `exception: ${(e as Error).message}` })
  }
  const o = outcomes.at(-1)!
  say(`  ${o.verdict} — ${o.detail}`)
}

// Départ d'un état vierge : aucun daemon, aucun fichier de découverte.
rmSync(TEST_HOME, { recursive: true, force: true })
// Deux clients = deux sessions Claude Code, chacune avec son serveur MCP.
const [a, b] = await Promise.all([connect('client-a'), connect('client-b')])

await scenario('S1 auto-démarrage + instance unique (2 clients simultanés)', async () => {
  // Les deux pings partent en même temps : les deux serveurs MCP tentent chacun de
  // lancer un daemon. Le verrou doit n'en laisser survivre qu'un.
  const [pa, pb] = (await Promise.all([
    a.callTool({ name: 'harness_ping', arguments: {} }),
    b.callTool({ name: 'harness_ping', arguments: {} }),
  ])).map(payload)
  const same = pa.pid === pb.pid && typeof pa.pid === 'number'
  return { verdict: same ? 'PASS' : 'FAIL', detail: `pid A=${pa.pid}, pid B=${pb.pid}` }
})

await scenario('S2 outils exposés (aucun outil d\'approbation)', async () => {
  const names = (await a.listTools()).tools.map((t) => t.name).sort()
  const leak = names.some((n) => n.includes('approve'))
  return { verdict: leak ? 'FAIL' : 'PASS', detail: names.join(', ') }
})

await scenario('S3 approbation : wait rend la main, puis termine après approbation', async () => {
  const d = payload(await a.callTool({ name: 'harness_delegate_task', arguments: { objective: 'S3', duration_s: 3, needs_approval: true } }))
  // Première attente : doit revenir dès la pause, bien avant ses 30 s.
  const w1 = payload(await a.callTool({ name: 'harness_wait_for_task', arguments: { task_id: d.task_id, timeout_s: 30 } }))
  // L'humain approuve directement auprès du daemon, comme le ferait `npm run approve`.
  const rt = readRuntime()!
  const appr = await daemonFetch(rt, `/tasks/${d.task_id}/approve`, { method: 'POST' })
  const w2 = payload(await a.callTool({ name: 'harness_wait_for_task', arguments: { task_id: d.task_id, timeout_s: 30 } }))
  const good = w1.next_action === 'human_approval_pending' && appr.status === 200 && w2.next_action === 'result_ready' && !!w2.result
  return { verdict: good ? 'PASS' : 'FAIL', detail: `wait#1=${w1.next_action} (${w1.waited_s}s), approve=${appr.status}, wait#2=${w2.next_action}` }
})

await scenario('S4 interrompre l\'attente n\'annule pas la tâche ; cancel explicite oui', async () => {
  const d = payload(await a.callTool({ name: 'harness_delegate_task', arguments: { objective: 'S4', duration_s: 20 } }))
  // Simule l'utilisateur qui appuie sur Échap dans Claude Code au bout de 2 s.
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 2_000)
  let aborted = false
  try {
    await a.callTool({ name: 'harness_wait_for_task', arguments: { task_id: d.task_id, timeout_s: 60 } }, undefined, { signal: ac.signal })
  } catch {
    aborted = true
  }
  // Laisse au serveur le temps de traiter l'annulation avant de vérifier l'état.
  await new Promise((r) => setTimeout(r, 300))
  const s = payload(await a.callTool({ name: 'harness_get_task_status', arguments: { task_id: d.task_id } }))
  const c1 = payload(await a.callTool({ name: 'harness_cancel_task', arguments: { task_id: d.task_id } }))
  // Une seconde annulation doit être refusée : la tâche est déjà finie.
  const c2 = payload(await a.callTool({ name: 'harness_cancel_task', arguments: { task_id: d.task_id } }))
  const good = aborted && ['running', 'queued'].includes(s.status) && c1.status === 'cancelled' && c2.isError === true
  return { verdict: good ? 'PASS' : 'FAIL', detail: `attente coupée=${aborted}, statut ensuite=${s.status}, cancel=${c1.status}, 2e cancel refusé=${c2.isError}` }
})

await scenario('S8 consignes d\'approbation exactes (défaut n° 1)', async () => {
  const instructions = a.getInstructions() ?? ''
  const d = payload(await a.callTool({ name: 'harness_delegate_task', arguments: { objective: 'S8', duration_s: 2, needs_approval: true } }))
  const w = payload(await a.callTool({ name: 'harness_wait_for_task', arguments: { task_id: d.task_id, timeout_s: 30 } }))
  const how = String(w.approval_instructions ?? '')
  // Débloque la tâche pour ne pas la laisser en pause pendant la suite.
  await daemonFetch(readRuntime()!, `/tasks/${d.task_id}/approve`, { method: 'POST' })
  const good = !/dashboard/i.test(instructions) && how.includes(`npm run approve -- ${d.task_id}`) && how.includes(SPIKE_ROOT)
  return { verdict: good ? 'PASS' : 'FAIL', detail: `dashboard mentionné=${/dashboard/i.test(instructions)}, consigne="${how.slice(0, 60)}…"` }
})

await scenario('S9 pause déjà signalée : l\'attente bloque jusqu\'à la décision (défaut n° 2)', async () => {
  const d = payload(await a.callTool({ name: 'harness_delegate_task', arguments: { objective: 'S9', duration_s: 3, needs_approval: true } }))
  const wait = (c: Client, timeout_s: number) =>
    c.callTool({ name: 'harness_wait_for_task', arguments: { task_id: d.task_id, timeout_s } }).then(payload)

  // 1. Première attente : la pause est nouvelle, elle est signalée.
  const w1 = await wait(a, 30)
  // 2. Le cas du test réel : on rappelle l'attente sans approbation. Avant correctif,
  //    réponse en ~2 ms ; désormais l'appel doit bloquer jusqu'à son délai (2 s).
  const w2 = await wait(a, 2)
  // 3. Un autre client n'a jamais vu cette pause : il doit être prévenu aussitôt.
  const wb = await wait(b, 10)
  // 4. L'humain approuve pendant une attente : elle doit aller jusqu'au résultat.
  setTimeout(() => void daemonFetch(readRuntime()!, `/tasks/${d.task_id}/approve`, { method: 'POST' }), 2_000)
  const w3 = await wait(a, 30)

  const good =
    w1.next_action === 'human_approval_pending' &&
    w2.next_action === 'still_waiting_for_human' && w2.waited_s >= 1.8 &&
    wb.next_action === 'human_approval_pending' && wb.waited_s < 1 &&
    w3.next_action === 'result_ready' && w3.waited_s >= 1.8
  return {
    verdict: good ? 'PASS' : 'FAIL',
    detail: `1er=${w1.next_action} ; rappel=${w2.next_action} après ${w2.waited_s}s ; ` +
      `autre client=${wb.next_action} après ${wb.waited_s}s ; après approbation=${w3.next_action} (${w3.waited_s}s)`,
  }
})

// Les deux attentes longues tournent en parallèle pour garder le test sous 2 minutes.
// 90 s : assez pour dépasser le timeout par défaut du client (60 s) avec de la marge.
const LONG_S = 90
await Promise.all([
  scenario(`S5 attente ${LONG_S}s SANS progression (client SDK par défaut, timeout 60s)`, async () => {
    const d = payload(await b.callTool({ name: 'harness_delegate_task', arguments: { objective: 'S5', duration_s: LONG_S } }))
    const start = Date.now()
    try {
      // Sans `onprogress`, le client n'envoie pas de jeton de progression : le serveur
      // ne peut donc pas le maintenir en vie, et le délai par défaut s'applique.
      const w = payload(await b.callTool({ name: 'harness_wait_for_task', arguments: { task_id: d.task_id, timeout_s: 120 } }))
      return { verdict: 'CONSTAT', detail: `pas de coupure : ${w.next_action} après ${w.waited_s}s` }
    } catch (e) {
      const secs = ((Date.now() - start) / 1000).toFixed(1)
      return { verdict: 'CONSTAT', detail: `coupé par le client après ${secs}s — ${(e as Error).message}` }
    }
  }),
  scenario(`S6 attente ${LONG_S}s AVEC progression + resetTimeoutOnProgress`, async () => {
    const d = payload(await a.callTool({ name: 'harness_delegate_task', arguments: { objective: 'S6', duration_s: LONG_S } }))
    const ticks: string[] = []
    // `onprogress` fait envoyer un jeton de progression ; `resetTimeoutOnProgress`
    // relance le délai de 60 s à chaque notification reçue.
    const w = payload(await a.callTool(
      { name: 'harness_wait_for_task', arguments: { task_id: d.task_id, timeout_s: 120 } },
      undefined,
      { onprogress: (p) => ticks.push(`${p.progress.toFixed(0)}s`), resetTimeoutOnProgress: true },
    ))
    // Au moins 4 notifications attendues sur 90 s avec des tranches de 15 s.
    const good = w.next_action === 'result_ready' && ticks.length >= 4
    return { verdict: good ? 'PASS' : 'FAIL', detail: `${w.next_action} après ${w.waited_s}s, ${ticks.length} notifications (${ticks.join(' ')})` }
  }),
])

await scenario('S7 daemon tué en cours de session : relance automatique', async () => {
  const before = readRuntime()!.pid
  const d = payload(await a.callTool({ name: 'harness_delegate_task', arguments: { objective: 'S7', duration_s: 60 } }))
  // SIGKILL : le pire cas, le daemon n'a pas le temps de nettoyer son verrou ni son
  // fichier de découverte. Le serveur MCP doit détecter les deux comme périmés.
  process.kill(before, 'SIGKILL')
  await new Promise((r) => setTimeout(r, 200))
  const p = payload(await a.callTool({ name: 'harness_ping', arguments: {} }))
  const lost = payload(await a.callTool({ name: 'harness_get_task_status', arguments: { task_id: d.task_id } }))
  const good = typeof p.pid === 'number' && p.pid !== before
  return {
    verdict: good ? 'PASS' : 'FAIL',
    detail: `pid ${before} → ${p.pid} ; tâche en vol après relance : ${lost.isError ? 'perdue (attendu sans persistance)' : lost.status}`,
  }
})

/**
 * Faux daemon « version 1 » : il répond à `/health` sans champ `protocol`, comme le
 * daemon d'avant la numérotation des pauses, et s'arrête sur `/shutdown`. Lancé
 * comme vrai processus, car le serveur MCP attend la disparition de son pid.
 * Arguments : dossier runtime, jeton.
 */
const FAKE_V1_DAEMON = `
const http = require('node:http'), fs = require('node:fs')
const [home, token] = process.argv.slice(1)
const srv = http.createServer((req, res) => {
  if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401); return res.end('{}') }
  if (req.url === '/health') return res.end(JSON.stringify({ ok: true, pid: process.pid }))
  if (req.url === '/shutdown') { res.end('{"ok":true}'); return process.exit(0) }
  res.writeHead(404); res.end('{}')
})
srv.listen(0, '127.0.0.1', () => fs.writeFileSync(home + '/daemon.json', JSON.stringify({
  pid: process.pid, port: srv.address().port, token, started_at: new Date().toISOString(),
}), { mode: 0o600 }))
`

await scenario('S10 daemon d\'une version antérieure remplacé au premier appel', async () => {
  // Arrêt propre du vrai daemon de test, pour installer le faux à sa place.
  const real = readRuntime()!
  await daemonFetch(real, '/shutdown', { method: 'POST' }).catch(() => {})
  while (pidAlive(real.pid)) await new Promise((r) => setTimeout(r, 50))

  const fake = spawn(process.execPath, ['-e', FAKE_V1_DAEMON, TEST_HOME, 'fake-token'], { stdio: 'ignore' })
  while (readRuntime()?.pid !== fake.pid) await new Promise((r) => setTimeout(r, 50))

  const p = payload(await a.callTool({ name: 'harness_ping', arguments: {} }))
  const fakeExited = fake.exitCode !== null || (await Promise.race([once(fake, 'exit').then(() => true), new Promise((r) => setTimeout(() => r(false), 1_000))]))
  const good = fakeExited && typeof p.pid === 'number' && p.pid !== fake.pid && p.protocol === PROTOCOL_VERSION
  return { verdict: good ? 'PASS' : 'FAIL', detail: `faux v1 pid ${fake.pid} arrêté=${fakeExited} → nouveau daemon pid ${p.pid}, protocole ${p.protocol}` }
})

// Nettoyage : arrêt du daemon de test puis fermeture des clients (qui arrête leurs serveurs MCP).
const rt = readRuntime()
if (rt) await daemonFetch(rt, '/shutdown', { method: 'POST' }).catch(() => {})
await Promise.all([a.close(), b.close()])

console.log('\n================ RÉSUMÉ ================')
for (const o of outcomes) console.log(`${o.verdict.padEnd(8)} ${o.name}\n         ${o.detail}`)
const failed = outcomes.filter((o) => o.verdict === 'FAIL').length
console.log(`\n${outcomes.length} scénarios, ${failed} échec(s), durée ${at()}`)
process.exit(failed ? 1 : 0)
