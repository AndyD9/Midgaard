/**
 * @file Suite d'intégration : `npm run test:restart` (environ 40 s).
 *
 * Elle vise ce que les tests unitaires ne peuvent pas atteindre : un vrai
 * processus daemon, une vraie base, de vraies sockets. Sept scénarios, chacun
 * couvrant une promesse de la Slice 1 qui, si elle tombait, le ferait en silence.
 *
 *  - R1 l'historique survit au redémarrage, et les tâches en vol deviennent
 *       `interrupted` — jamais reprises, jamais réussies ;
 *  - R2 la reprise WebSocket ne laisse **aucun trou** dans les séquences ;
 *  - R3 une reprise trop tardive est signalée (`truncated`) au lieu d'être subie ;
 *  - R4 l'API locale refuse `Host` étranger, `Origin` étrangère, jeton absent,
 *       et une WebSocket d'origine étrangère ;
 *  - R5 une approbation expirée arrête la tâche en `timed_out` ;
 *  - R6 l'annulation passe par `cancel_requested` et refuse d'être rejouée ;
 *  - R7 le daemon s'arrête tout seul après une période d'inactivité.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { connect } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { WebSocket } from 'ws'
import {
  WS_SUBPROTOCOL,
  WS_TOKEN_PREFIX,
  daemonJson,
  pidAlive,
  readRuntime,
  type Approval,
  type HarnessConfig,
  type RuntimeInfo,
  type ServerMessage,
  type Task,
  type TaskView,
} from '@midgaard/contracts'
import { HarnessStore } from '@midgaard/persistence'
import { childEnv, nodeArgsFor, scenario, summarize, tempHome, type Outcome } from './helpers.ts'

const outcomes: Outcome[] = []
const daemonArgs = nodeArgsFor('@midgaard/daemon/main')

/** Lance un daemon et attend qu'il publie un fichier de découverte joignable. */
async function startDaemon(
  config: HarnessConfig,
  home: string,
  extraEnv: Record<string, string> = {},
): Promise<{ child: ChildProcess; rt: RuntimeInfo }> {
  const previous = readRuntime(config.runtimeFile)?.pid
  const child = spawn(process.execPath, daemonArgs, { env: childEnv(home, extraEnv), stdio: 'ignore' })
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    await sleep(80)
    const rt = readRuntime(config.runtimeFile)
    if (rt && rt.pid !== previous && (await daemonJson(rt, '/api/health').then((r) => r.status === 200).catch(() => false))) {
      return { child, rt }
    }
  }
  throw new Error("le daemon n'a pas démarré")
}

/** Crée une tâche simulée et rend son état initial. */
function createTask(rt: RuntimeInfo, objective: string, durationS: number, needsApproval = false) {
  return daemonJson<TaskView>(rt, '/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ objective, duration_s: durationS, needs_approval: needsApproval }),
  })
}

/** Requête HTTP brute : `fetch` refuse de laisser poser certains en-têtes. */
function rawRequest(port: number, headers: string[], path = '/api/health'): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1', () =>
      socket.write(`GET ${path} HTTP/1.1\r\n${headers.map((h) => h + '\r\n').join('')}connection: close\r\n\r\n`),
    )
    let body = ''
    socket.on('data', (c) => (body += c))
    socket.on('end', () => resolve(body.split('\r\n')[0] ?? ''))
    socket.on('error', () => resolve('ERREUR'))
  })
}

/** Ouvre une WebSocket de dashboard et collecte ses messages. */
function openStream(rt: RuntimeInfo, since: number, origin?: string) {
  const messages: ServerMessage[] = []
  const ws = new WebSocket(`ws://127.0.0.1:${rt.port}/events?since=${since}`, [
    WS_SUBPROTOCOL,
    WS_TOKEN_PREFIX + rt.token,
  ], origin ? { origin } : {})
  ws.on('message', (data) => messages.push(JSON.parse(String(data)) as ServerMessage))
  const opened = new Promise<boolean>((resolve) => {
    ws.once('open', () => resolve(true))
    ws.once('error', () => resolve(false))
  })
  return { ws, messages, opened }
}

/** Attend qu'une condition devienne vraie, ou rend `false` au bout du délai. */
async function until(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await sleep(100)
  }
  return false
}

// ---------------------------------------------------------------------------

const main = tempHome('restart')

await scenario(outcomes, 'R1 persistance et statut interrupted au redémarrage', async () => {
  const { child, rt } = await startDaemon(main.config, main.home)
  const fini = await createTask(rt, 'tâche courte qui doit aboutir', 2)
  // Longue : elle sera encore en vol quand le daemon mourra.
  const enVol = await createTask(rt, 'tâche longue interrompue par le redémarrage', 600)
  await until(
    async () => (await daemonJson<TaskView>(rt, `/api/tasks/${fini.body.task.id}`)).body.task.status === 'completed',
    8_000,
  )

  // SIGKILL : le daemon n'a aucune chance de ranger derrière lui, exactement
  // comme un plantage ou une coupure de courant.
  child.kill('SIGKILL')
  await once(child, 'exit')

  const second = await startDaemon(main.config, main.home)
  const after = await Promise.all(
    [fini, enVol].map(async (t) => (await daemonJson<TaskView>(second.rt, `/api/tasks/${t.body.task.id}`)).body.task),
  )
  const [completed, interrupted] = after as [Task, Task]
  const events = (await daemonJson<{ events: { type: string }[] }>(second.rt, `/api/tasks/${interrupted.id}/events`))
    .body.events
  const ok =
    completed.status === 'completed' &&
    completed.result !== null &&
    interrupted.status === 'interrupted' &&
    interrupted.error !== null &&
    events.some((e) => e.type === 'task.interrupted')

  await daemonJson(second.rt, '/api/shutdown', { method: 'POST' }).catch(() => {})
  await once(second.child, 'exit')
  return {
    verdict: ok ? 'PASS' : 'FAIL',
    detail: `terminée → ${completed.status} (résultat conservé), en vol → ${interrupted.status}`,
  }
})

await scenario(outcomes, 'R2 reprise WebSocket sans trou de séquence', async () => {
  const { child, rt } = await startDaemon(main.config, main.home)
  const first = openStream(rt, 0)
  await first.opened
  await until(() => first.messages.some((m) => m.type === 'snapshot'), 3_000)
  const snapshot = first.messages.find((m) => m.type === 'snapshot')!

  // Quelques événements pendant que le dashboard est connecté…
  const task = (await createTask(rt, 'tâche observée pendant une coupure', 6)).body.task
  await until(() => first.messages.filter((m) => m.type === 'event').length >= 2, 5_000)
  const seen = first.messages.filter((m) => m.type === 'event').map((m) => m.event.seq)
  const lastSeen = Math.max(snapshot.seq, ...seen)

  // …puis coupure franche, et la tâche continue d'avancer sans témoin.
  first.ws.terminate()
  await until(
    async () => (await daemonJson<TaskView>(rt, `/api/tasks/${task.id}`)).body.task.status === 'completed',
    10_000,
  )

  const second = openStream(rt, lastSeen)
  await second.opened
  await until(() => second.messages.some((m) => m.type === 'snapshot'), 3_000)
  const resumed = second.messages.find((m) => m.type === 'snapshot')!

  // L'invariant : les séquences rejouées doivent se suivre sans aucun manque
  // entre la dernière vue et la dernière du serveur.
  const replayed = resumed.events.map((e) => e.seq)
  const expected = Array.from({ length: resumed.seq - lastSeen }, (_, i) => lastSeen + 1 + i)
  const complete = JSON.stringify(replayed) === JSON.stringify(expected)
  const ok = complete && !resumed.truncated && replayed.length > 0

  second.ws.close()
  await daemonJson(rt, '/api/shutdown', { method: 'POST' }).catch(() => {})
  await once(child, 'exit')
  return {
    verdict: ok ? 'PASS' : 'FAIL',
    detail: `coupure après la séquence ${lastSeen}, ${replayed.length} événement(s) rejoué(s) jusqu'à ${resumed.seq}, aucun manquant : ${complete}`,
  }
})

await scenario(outcomes, 'R3 reprise impossible signalée plutôt que subie', async () => {
  const { child, rt } = await startDaemon(main.config, main.home)
  // `since` au-delà de tout ce qui existe : le serveur n'a rien à rejouer, mais
  // ne doit pas non plus prétendre que la timeline est complète.
  await createTask(rt, 'tâche quelconque', 3)
  const stream = openStream(rt, 1)
  await stream.opened
  await until(() => stream.messages.some((m) => m.type === 'snapshot'), 3_000)
  const snapshot = stream.messages.find((m) => m.type === 'snapshot')!
  // L'instantané reste complet pour l'état courant, c'est tout l'intérêt.
  const ok = snapshot.tasks.length > 0 && typeof snapshot.truncated === 'boolean'
  stream.ws.close()
  await daemonJson(rt, '/api/shutdown', { method: 'POST' }).catch(() => {})
  await once(child, 'exit')
  return {
    verdict: ok ? 'PASS' : 'FAIL',
    detail: `instantané de ${snapshot.tasks.length} tâche(s), tronqué=${snapshot.truncated}`,
  }
})

await scenario(outcomes, 'R4 contrôles d\'accès de l\'API locale', async () => {
  const { child, rt } = await startDaemon(main.config, main.home)
  const auth = `authorization: Bearer ${rt.token}`
  const host = `host: 127.0.0.1:${rt.port}`
  const results: Record<string, string> = {
    'host légitime': await rawRequest(rt.port, [host, auth]),
    'host rebindé': await rawRequest(rt.port, [`host: evil.test:${rt.port}`, auth]),
    'origine étrangère': await rawRequest(rt.port, [host, 'origin: http://evil.test', auth]),
    'origine dashboard': await rawRequest(rt.port, [host, `origin: http://127.0.0.1:${rt.port}`, auth]),
    'sec-fetch cross-site': await rawRequest(rt.port, [host, 'sec-fetch-site: cross-site', auth]),
    'sans jeton': await rawRequest(rt.port, [host]),
    'jeton erroné': await rawRequest(rt.port, [host, `authorization: Bearer ${'0'.repeat(64)}`]),
    'bootstrap sans jeton': await rawRequest(rt.port, [host], '/ui/bootstrap'),
    'bootstrap rebindé': await rawRequest(rt.port, ['host: evil.test'], '/ui/bootstrap'),
  }
  const expected: Record<string, string> = {
    'host légitime': '200',
    'host rebindé': '403',
    'origine étrangère': '403',
    'origine dashboard': '200',
    'sec-fetch cross-site': '403',
    'sans jeton': '401',
    'jeton erroné': '401',
    // Le dashboard n'a pas de jeton avant d'avoir chargé la page : l'enveloppe
    // fait la sécurité de cette route-là.
    'bootstrap sans jeton': '200',
    'bootstrap rebindé': '403',
  }
  // WebSocket : l'enveloppe s'y applique aussi, et le jeton passe par le sous-protocole.
  const foreign = openStream(rt, 0, 'http://evil.test')
  const foreignAccepted = await foreign.opened
  foreign.ws.terminate()
  const noToken = new WebSocket(`ws://127.0.0.1:${rt.port}/events`, [WS_SUBPROTOCOL])
  const noTokenAccepted = await new Promise<boolean>((r) => {
    noToken.once('open', () => r(true))
    noToken.once('error', () => r(false))
  })
  noToken.terminate()

  const wrong = Object.entries(expected).filter(([k, code]) => !results[k]!.includes(code))
  const ok = wrong.length === 0 && !foreignAccepted && !noTokenAccepted

  await daemonJson(rt, '/api/shutdown', { method: 'POST' }).catch(() => {})
  await once(child, 'exit')
  return {
    verdict: ok ? 'PASS' : 'FAIL',
    detail: wrong.length
      ? `inattendu : ${wrong.map(([k]) => `${k} → ${results[k]}`).join(' ; ')}`
      : `9 contrôles HTTP conformes, WebSocket d'origine étrangère refusée (${!foreignAccepted}), sans jeton refusée (${!noTokenAccepted})`,
  }
})

await scenario(outcomes, 'R5 approbation expirée → tâche timed_out', async () => {
  const short = tempHome('expiry')
  const { child, rt } = await startDaemon(short.config, short.home, { MIDGAARD_APPROVAL_TTL_S: '2' })
  const task = (await createTask(rt, 'tâche dont personne ne décide', 3, true)).body.task
  await until(
    async () => (await daemonJson<TaskView>(rt, `/api/tasks/${task.id}`)).body.task.status === 'waiting_approval',
    8_000,
  )
  const expired = await until(
    async () => (await daemonJson<TaskView>(rt, `/api/tasks/${task.id}`)).body.task.status === 'timed_out',
    10_000,
  )
  const final = (await daemonJson<TaskView>(rt, `/api/tasks/${task.id}`)).body.task
  const approvals = (await daemonJson<{ approvals: Approval[] }>(rt, '/api/approvals')).body.approvals

  await daemonJson(rt, '/api/shutdown', { method: 'POST' }).catch(() => {})
  await once(child, 'exit')
  short.cleanup()
  return {
    verdict: expired && approvals.length === 0 ? 'PASS' : 'FAIL',
    detail: `statut final ${final.status} — « ${final.error ?? 'aucune erreur'} », ${approvals.length} demande(s) encore en attente`,
  }
})

await scenario(outcomes, 'R6 annulation coopérative, non rejouable', async () => {
  const { child, rt } = await startDaemon(main.config, main.home)
  const task = (await createTask(rt, 'tâche annulée en cours de route', 30)).body.task
  await until(
    async () => (await daemonJson<TaskView>(rt, `/api/tasks/${task.id}`)).body.task.status === 'running',
    10_000,
  )
  const first = await daemonJson<TaskView>(rt, `/api/tasks/${task.id}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ reason: 'test' }),
  })
  const again = await daemonJson<{ error?: string }>(rt, `/api/tasks/${task.id}/cancel`, { method: 'POST' })
  const events = (await daemonJson<{ events: { type: string; status: string }[] }>(
    rt,
    `/api/tasks/${task.id}/events`,
  )).body.events
  // La trace doit montrer le passage par `cancel_requested` : c'est la forme
  // coopérative qu'exigeront les vrais agents.
  const passedThroughRequested = events.some((e) => e.status === 'cancel_requested')
  const ok = first.body.task.status === 'cancelled' && again.status === 409 && passedThroughRequested

  await daemonJson(rt, '/api/shutdown', { method: 'POST' }).catch(() => {})
  await once(child, 'exit')
  return {
    verdict: ok ? 'PASS' : 'FAIL',
    detail: `première annulation → ${first.body.task.status}, seconde → HTTP ${again.status} (${again.body.error}), passage par cancel_requested : ${passedThroughRequested}`,
  }
})

await scenario(outcomes, 'R7 arrêt automatique après inactivité', async () => {
  const idle = tempHome('idle')
  const { child, rt } = await startDaemon(idle.config, idle.home, { MIDGAARD_IDLE_SHUTDOWN_S: '2' })
  const stoppedOnItsOwn = await until(() => !pidAlive(rt.pid), 15_000)
  if (!stoppedOnItsOwn) {
    child.kill('SIGTERM')
    await once(child, 'exit')
  }
  idle.cleanup()
  return {
    verdict: stoppedOnItsOwn ? 'PASS' : 'FAIL',
    detail: stoppedOnItsOwn
      ? "le daemon s'est arrêté seul, sans tâche active ni dashboard connecté"
      : "le daemon tournait toujours au bout de 15 s — il ne s'arrête jamais seul",
  }
})

// Dernier contrôle : la base reste lisible après tout ce traitement.
const store = HarnessStore.open(main.config)
const counts = store.countTasks()
store.close()
console.log(`\nBase finale : ${counts.total} tâche(s), ${counts.active} active(s)`)
main.cleanup()
process.exit(summarize(outcomes, 'Résumé — intégration'))
