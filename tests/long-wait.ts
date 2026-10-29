/**
 * @file Suite de bout en bout MCP : `npm run test:wait` (environ 3 min).
 *
 * Exerce le serveur MCP avec le **client officiel du SDK**, en stdio — le même
 * protocole que Claude Code. Rien n'est simulé de notre côté : de vrais
 * processus (serveur MCP, daemon) sont lancés, et c'est le seul test qui valide
 * l'ergonomie de `harness_wait_for_task`.
 *
 * Il ne remplace pas un essai dans une vraie session Claude Code : le client du
 * SDK n'a pas forcément les mêmes délais ni les mêmes habitudes que le client
 * réel. C'est pourquoi le serveur MCP écrit une trace JSONL de ses attentes.
 *
 *  - S1 deux clients simultanés sans daemon → un seul daemon démarre ;
 *  - S2 aucun outil d'approbation n'est exposé au modèle ;
 *  - S3 l'attente rend la main sur une approbation, puis aboutit après celle-ci ;
 *  - S4 interrompre l'attente ne coupe pas la tâche ; `cancel` oui, et pas deux fois ;
 *  - S5 attente longue **sans** progression : mesure où le client coupe ;
 *  - S6 attente longue **avec** progression : doit tenir jusqu'au bout ;
 *  - S7 daemon tué en cours de session → relancé au prochain appel ;
 *  - S8 consignes d'approbation exactes, et l'URL annoncée sert vraiment le
 *    dashboard (défaut n° 1 de la Slice 0) ;
 *  - S9 une pause déjà signalée fait bloquer l'attente jusqu'à la décision, alors
 *    qu'un client qui ne l'a jamais vue est prévenu aussitôt (défaut n° 2) ;
 *  - S10 un daemon d'une autre version de protocole est remplacé au premier appel ;
 *  - S11 `harness_get_task_result` rend le résultat structuré d'une tâche finie ;
 *  - S12 une tâche interrompue par un redémarrage est rapportée comme telle à Claude.
 *
 * Verdicts : `PASS`/`FAIL` pour les comportements garantis ; `CONSTAT` pour une
 * mesure d'environnement qui n'engage pas notre code.
 */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { PROTOCOL_VERSION, daemonJson, pidAlive, readRuntime, type Approval } from '@midgaard/contracts'
import { childEnv, nodeArgsFor, scenario, summarize, tempHome, type Outcome } from './helpers.ts'

/** Durée des attentes longues (S5/S6). Doit dépasser nettement la coupure à 60 s du client. */
const LONG_WAIT_S = 75

const { home, config, cleanup } = tempHome('mcp')
const outcomes: Outcome[] = []
const mcpArgs = nodeArgsFor('@midgaard/mcp-server/main')
const t0 = Date.now()
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`

/**
 * Lance un serveur MCP (processus réel) et y connecte un client.
 * `getDefaultEnvironment()` reproduit l'environnement minimal que le SDK
 * transmet aux serveurs stdio ; on y ajoute le dossier runtime de test.
 */
async function connect(name: string): Promise<Client> {
  const client = new Client({ name, version: '0' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: mcpArgs,
      env: { ...getDefaultEnvironment(), ...childEnv(home) } as Record<string, string>,
      stderr: 'ignore',
    }),
  )
  return client
}

/** Extrait la réponse d'un appel d'outil : le JSON renvoyé, plus `isError`. */
function payload(res: unknown): Record<string, any> {
  const r = res as { content: { text: string }[]; isError?: boolean }
  const text = r.content[0]?.text ?? ''
  try {
    return { ...JSON.parse(text), isError: r.isError }
  } catch {
    return { message: text, isError: r.isError }
  }
}

/** Raccourci : délègue une tâche et rend son identifiant. */
async function delegate(client: Client, objective: string, durationS: number, needsApproval = false) {
  const res = payload(await client.callTool({ name: 'harness_delegate_task', arguments: { objective, duration_s: durationS, needs_approval: needsApproval } }))
  return res.task_id as string
}

/** Approuve la demande en attente, comme le ferait un humain avec la CLI. */
async function humanApproves(): Promise<string | null> {
  const rt = readRuntime(config.runtimeFile)
  if (!rt) return null
  const { body } = await daemonJson<{ approvals: Approval[] }>(rt, '/api/approvals')
  const pending = body.approvals[0]
  if (!pending) return null
  await daemonJson(rt, `/api/approvals/${pending.id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ by: 'cli' }),
  })
  return pending.id
}

// --- Départ d'un état vierge : aucun daemon, aucun fichier de découverte ----
const [a, b] = await Promise.all([connect('client-a'), connect('client-b')])

await scenario(outcomes, 'S1 auto-démarrage et instance unique (2 clients simultanés)', async () => {
  // Les deux pings partent ensemble : les deux serveurs MCP tentent chacun de
  // lancer un daemon. Le verrou doit n'en laisser survivre qu'un.
  const [rawA, rawB] = await Promise.all([
    a.callTool({ name: 'harness_ping', arguments: {} }),
    b.callTool({ name: 'harness_ping', arguments: {} }),
  ])
  const pa = payload(rawA)
  const pb = payload(rawB)
  const same = pa.pid === pb.pid && typeof pa.pid === 'number'
  return { verdict: same ? 'PASS' : 'FAIL', detail: `pid A=${pa.pid}, pid B=${pb.pid}, protocole ${pa.protocol}` }
})

await scenario(outcomes, "S2 outils exposés, aucun outil d'approbation", async () => {
  const names = (await a.listTools()).tools.map((t) => t.name).sort()
  // L'invariant : Claude ne doit avoir aucun moyen de s'auto-approuver.
  const leak = names.some((n) => /approve|reject|decide/i.test(n))
  return { verdict: leak ? 'FAIL' : 'PASS', detail: names.join(', ') }
})

await scenario(outcomes, "S3 l'attente rend la main sur une pause, puis aboutit", async () => {
  const id = await delegate(a, 'tâche avec approbation', 10, true)
  const paused = payload(await a.callTool({ name: 'harness_wait_for_task', arguments: { task_id: id, timeout_s: 30 } }))
  if (paused.next_action !== 'human_approval_pending') {
    return { verdict: 'FAIL', detail: `attendu human_approval_pending, reçu ${paused.next_action}` }
  }
  // L'attente suivante bloque jusqu'à la décision : on approuve pendant.
  const waiting = a.callTool({ name: 'harness_wait_for_task', arguments: { task_id: id, timeout_s: 40 } })
  await sleep(500)
  await humanApproves()
  const done = payload(await waiting)
  const ok = done.next_action === 'result_ready' && typeof done.result?.summary === 'string'
  return { verdict: ok ? 'PASS' : 'FAIL', detail: `pause après ${paused.waited_s}s, fin après ${done.waited_s}s → ${done.next_action}` }
})

await scenario(outcomes, "S4 interrompre l'attente ne coupe pas la tâche", async () => {
  const id = await delegate(a, 'tâche longue interrompue côté client', 60)
  const aborter = new AbortController()
  const waiting = a.callTool({ name: 'harness_wait_for_task', arguments: { task_id: id, timeout_s: 60 } }, undefined, { signal: aborter.signal })
  await sleep(1_500)
  aborter.abort()
  await waiting.catch(() => {})
  await sleep(500)

  const after = payload(await a.callTool({ name: 'harness_get_task_status', arguments: { task_id: id } }))
  const stillRunning = ['queued', 'preparing', 'running'].includes(after.status)
  const cancelled = payload(await a.callTool({ name: 'harness_cancel_task', arguments: { task_id: id } }))
  const twice = payload(await a.callTool({ name: 'harness_cancel_task', arguments: { task_id: id } }))
  const ok = stillRunning && cancelled.status === 'cancelled' && twice.isError === true
  return {
    verdict: ok ? 'PASS' : 'FAIL',
    detail: `après interruption → ${after.status}, annulation → ${cancelled.status}, seconde annulation refusée : ${twice.isError === true}`,
  }
})

await scenario(outcomes, `S5 attente de ${LONG_WAIT_S}s SANS notifications de progression`, async () => {
  // Sans `onprogress`, le SDK n'envoie pas de jeton de progression : le client
  // coupe alors l'appel à son délai par défaut. Mesure d'environnement, pas un
  // échec de notre code — c'est elle qui justifie l'attente par tranches.
  const id = await delegate(a, 'attente sans progression', LONG_WAIT_S)
  const started = Date.now()
  try {
    const res = payload(await a.callTool({ name: 'harness_wait_for_task', arguments: { task_id: id, timeout_s: LONG_WAIT_S + 10 } }))
    return { verdict: 'CONSTAT', detail: `pas de coupure, ${((Date.now() - started) / 1000).toFixed(1)}s → ${res.next_action}` }
  } catch (e) {
    return { verdict: 'CONSTAT', detail: `coupé par le client après ${((Date.now() - started) / 1000).toFixed(1)}s : ${(e as Error).message}` }
  } finally {
    await a.callTool({ name: 'harness_cancel_task', arguments: { task_id: id } }).catch(() => {})
  }
})

await scenario(outcomes, `S6 attente de ${LONG_WAIT_S}s AVEC progression`, async () => {
  // C'est l'invariant qui rend `wait_for_task` viable : les notifications
  // remettent à zéro le délai du client entre deux tranches.
  const id = await delegate(a, 'attente avec progression', LONG_WAIT_S)
  let notifications = 0
  const started = Date.now()
  const res = payload(
    await a.callTool(
      { name: 'harness_wait_for_task', arguments: { task_id: id, timeout_s: LONG_WAIT_S + 30 } },
      undefined,
      { onprogress: () => notifications++, resetTimeoutOnProgress: true },
    ),
  )
  const elapsed = (Date.now() - started) / 1000
  const ok = res.next_action === 'result_ready' && elapsed > 60 && notifications >= 4
  return {
    verdict: ok ? 'PASS' : 'FAIL',
    detail: `${elapsed.toFixed(1)}s tenues, ${notifications} notification(s) → ${res.next_action}`,
  }
})

await scenario(outcomes, 'S7 daemon tué en cours de session, relancé au prochain appel', async () => {
  const before = readRuntime(config.runtimeFile)!
  process.kill(before.pid, 'SIGKILL')
  await sleep(300)
  const ping = payload(await a.callTool({ name: 'harness_ping', arguments: {} }))
  const ok = typeof ping.pid === 'number' && ping.pid !== before.pid && !pidAlive(before.pid)
  return { verdict: ok ? 'PASS' : 'FAIL', detail: `pid ${before.pid} tué → nouveau pid ${ping.pid}` }
})

await scenario(outcomes, "S8 consignes d'approbation exactes et vérifiables", async () => {
  const id = await delegate(a, 'tâche dont la consigne sera inspectée', 8, true)
  const paused = payload(await a.callTool({ name: 'harness_wait_for_task', arguments: { task_id: id, timeout_s: 30 } }))
  const instructions = String(paused.approval_instructions ?? '')
  const problems: string[] = []
  // Aucun `<placeholder>` : zsh lirait `<` et `>` comme des redirections.
  if (/[<>]/.test(instructions)) problems.push('contient un placeholder')
  if (!instructions.includes(paused.approval_id)) problems.push("ne porte pas l'identifiant de la demande")
  if (!/harness (approve|run harness)|npm run harness/.test(instructions)) problems.push('aucune commande exacte')

  // L'invariant du défaut n° 1 : si une URL de dashboard est annoncée, elle doit
  // vraiment servir le dashboard — pas la page « non compilé ».
  const url = /http:\/\/127\.0\.0\.1:\d+\//.exec(instructions)?.[0]
  if (url) {
    const page = await fetch(url).then((r) => r.text()).catch(() => '')
    if (/non compilé/.test(page)) problems.push("l'URL annoncée ne sert pas le dashboard")
  }

  await a.callTool({ name: 'harness_cancel_task', arguments: { task_id: id } }).catch(() => {})
  return {
    verdict: problems.length ? 'FAIL' : 'PASS',
    detail: problems.length ? problems.join(' ; ') : `consigne vérifiée${url ? `, dashboard servi à ${url}` : ', sans dashboard'}`,
  }
})

await scenario(outcomes, 'S9 pause déjà signalée : bloque pour ce client, alerte les autres', async () => {
  const id = await delegate(a, 'tâche à double attente', 12, true)
  const first = payload(await a.callTool({ name: 'harness_wait_for_task', arguments: { task_id: id, timeout_s: 30 } }))
  if (first.next_action !== 'human_approval_pending') {
    return { verdict: 'FAIL', detail: `première attente : ${first.next_action}` }
  }

  // Un autre client n'a jamais vu cette pause : il doit être prévenu tout de suite.
  const other = payload(await b.callTool({ name: 'harness_get_task_status', arguments: { task_id: id } }))

  // Ce client-ci, lui, doit bloquer : il a déjà prévenu son humain.
  const started = Date.now()
  const blocking = a.callTool({ name: 'harness_wait_for_task', arguments: { task_id: id, timeout_s: 40 } })
  await sleep(3_000)
  const stillBlocked = Date.now() - started >= 3_000
  await humanApproves()
  const resumed = payload(await blocking)
  const blockedFor = (Date.now() - started) / 1000

  const ok =
    other.next_action === 'human_approval_pending' &&
    stillBlocked &&
    blockedFor > 2.5 &&
    resumed.next_action === 'result_ready'
  return {
    verdict: ok ? 'PASS' : 'FAIL',
    detail: `autre client prévenu aussitôt (${other.next_action}), ce client bloqué ${blockedFor.toFixed(1)}s → ${resumed.next_action}`,
  }
})

await scenario(outcomes, "S10 daemon d'une autre version de protocole, remplacé", async () => {
  // On arrête le daemon courant et on met à sa place un imposteur qui annonce
  // une version de protocole différente, comme le ferait un daemon resté actif
  // après une mise à jour du code.
  const current = readRuntime(config.runtimeFile)!
  await daemonJson(current, '/api/shutdown', { method: 'POST' }).catch(() => {})
  await sleep(300)

  let shutdownAsked = false
  const impostor = createServer((req, res) => {
    if (req.url === '/api/shutdown') shutdownAsked = true
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, protocol: PROTOCOL_VERSION - 1, pid: process.pid }))
  })
  impostor.listen(0, '127.0.0.1')
  await once(impostor, 'listening')
  const port = (impostor.address() as { port: number }).port
  writeFileSync(
    config.runtimeFile,
    JSON.stringify({
      pid: process.pid,
      port,
      token: 'z'.repeat(64),
      started_at: new Date().toISOString(),
      protocol: PROTOCOL_VERSION - 1,
      dashboard_url: `http://127.0.0.1:${port}/`,
    }),
    { mode: 0o600 },
  )

  const ping = payload(await a.callTool({ name: 'harness_ping', arguments: {} }))
  impostor.close()
  const ok = shutdownAsked && ping.protocol === PROTOCOL_VERSION && ping.pid !== process.pid
  return {
    verdict: ok ? 'PASS' : 'FAIL',
    detail: `arrêt demandé à l'imposteur : ${shutdownAsked}, nouveau daemon pid ${ping.pid} en protocole ${ping.protocol}`,
  }
})

await scenario(outcomes, 'S11 harness_get_task_result rend le résultat structuré', async () => {
  const id = await delegate(a, 'tâche dont on relira le résultat', 4)
  await a.callTool({ name: 'harness_wait_for_task', arguments: { task_id: id, timeout_s: 30 } }, undefined, {
    onprogress: () => {},
    resetTimeoutOnProgress: true,
  })
  const result = payload(await a.callTool({ name: 'harness_get_task_result', arguments: { task_id: id } }))

  // Sur une tâche encore en cours, l'outil ne doit pas attendre ni inventer.
  const running = await delegate(a, 'tâche encore en cours', 120)
  const tooEarly = payload(await a.callTool({ name: 'harness_get_task_result', arguments: { task_id: running } }))
  await a.callTool({ name: 'harness_cancel_task', arguments: { task_id: running } }).catch(() => {})

  const ok =
    result.status === 'completed' &&
    typeof result.result?.summary === 'string' &&
    Array.isArray(result.result?.steps) &&
    tooEarly.result === undefined &&
    typeof tooEarly.note === 'string'
  return {
    verdict: ok ? 'PASS' : 'FAIL',
    detail: `terminée → ${result.result?.steps?.length ?? 0} étape(s) rapportées ; en cours → ${tooEarly.next_action}`,
  }
})

await scenario(outcomes, 'S12 tâche interrompue rapportée comme telle à Claude', async () => {
  const id = await delegate(a, 'tâche que le redémarrage va interrompre', 300)
  await sleep(600)
  const rt = readRuntime(config.runtimeFile)!
  process.kill(rt.pid, 'SIGKILL')
  await sleep(300)

  // Le prochain appel relance le daemon, qui réconcilie l'état avant de répondre.
  const status = payload(await a.callTool({ name: 'harness_get_task_status', arguments: { task_id: id } }))
  const ok =
    status.status === 'interrupted' &&
    status.next_action === 'task_ended_without_result' &&
    typeof status.error === 'string' &&
    status.result === undefined
  return {
    verdict: ok ? 'PASS' : 'FAIL',
    detail: `${status.status} / ${status.next_action} — « ${status.error ?? 'aucune erreur'} »`,
  }
})

console.log(`\nDurée totale : ${at()}`)
await Promise.all([a.close(), b.close()])
const last = readRuntime(config.runtimeFile)
if (last) await daemonJson(last, '/api/shutdown', { method: 'POST' }).catch(() => {})
await sleep(300)
cleanup()
process.exit(summarize(outcomes, 'Résumé — bout en bout MCP'))
