/**
 * @file Essai réel : `npm run test:live`. **Dépense de l'argent.**
 *
 * C'est le seul test qui prouve le livrable de la Slice 2 — « le coût affiché
 * correspond à la facture ». Tous les autres tournent contre un faux
 * fournisseur, ce qui est voulu : ils doivent être gratuits, hors ligne et
 * reproductibles. Celui-ci ne peut être aucun des trois, et c'est pourquoi il
 * est **opt-in** et séparé de `npm test`.
 *
 * Il ne tourne que si une clé est déjà déposée dans le coffre, sous la
 * référence d'un fournisseur configuré. Sans clé, il **s'abstient** au lieu
 * d'échouer : une absence de clé n'est pas un défaut du code.
 *
 *  - L1 le Researcher est annoncé disponible, et il l'est réellement ;
 *  - L2 une vraie tâche aboutit à un résultat structuré, outils à l'appui ;
 *  - L3 **le coût affiché correspond au solde réellement débité** ;
 *  - L4 un budget volontairement bas arrête la tâche, sans appel de trop ;
 *  - L5 ce qui revient du web remonte encadré, avec ses sources.
 *
 * Le solde est relevé chez Venice **avant et après**, et comparé à ce que le
 * harness a compté. C'est la seule façon de vérifier qu'on ne raconte pas
 * d'histoires : un tableau de tarifs peut mentir, un solde non.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { daemonJson, loadConfig, readRuntime, type ProviderConfig } from '@midgaard/contracts'
import { openVault } from '@midgaard/secrets'
import { childEnv, nodeArgsFor, scenario, summarize, tempHome, type Outcome } from './helpers.ts'

/** Identifiant du fournisseur attendu dans le coffre de l'utilisateur. */
const PROVIDER_ID = process.env.MIDGAARD_LIVE_PROVIDER ?? 'venice'
/** Modèle employé. Bon marché, appelle des outils, sait chercher sur le web. */
const MODEL = process.env.MIDGAARD_LIVE_MODEL ?? 'deepseek-v4-flash-0731'
/** Budget de chaque tâche réelle. Volontairement bas : un essai ne doit pas coûter cher. */
const BUDGET_USD = Number(process.env.MIDGAARD_LIVE_BUDGET ?? 0.03)

const outcomes: Outcome[] = []

// --- La clé existe-t-elle ? -------------------------------------------------
// On lit le coffre **de l'utilisateur**, pas celui du test : c'est là que
// `harness providers add` l'a déposée. Le dossier runtime de l'essai, lui,
// restera jetable.
const realConfig = loadConfig({ MIDGAARD_HOME: join(homedir(), '.midgaard') })
const userVault = await openVault(realConfig, process.env)
const apiKey = await userVault.get(`provider.${PROVIDER_ID}`)

if (!apiKey) {
  console.log(`Aucune clé pour « ${PROVIDER_ID} » dans le coffre (${userVault.label}).`)
  console.log('Cet essai réel est ignoré — ce n\'est pas un échec.')
  console.log()
  console.log('Pour le rendre exécutable :')
  console.log(`  npm run harness -- providers add ${PROVIDER_ID} --model ${MODEL}`)
  process.exit(0)
}

// --- Dossier runtime jetable, coffre fichier --------------------------------
// `MIDGAARD_VAULT=file` est essentiel : le coffre système est par **utilisateur**,
// pas par dossier runtime. Sans cela, l'essai réécrirait la clé de l'utilisateur
// sous la même référence.
const { home, config, cleanup } = tempHome('live')
const env = childEnv(home, { MIDGAARD_VAULT: 'file' })
const mcpArgs = nodeArgsFor('@midgaard/mcp-server/main')

async function connect(name: string): Promise<Client> {
  const client = new Client({ name, version: '0' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: mcpArgs,
      env: { ...getDefaultEnvironment(), ...env } as Record<string, string>,
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

/**
 * Solde du compte, relevé **chez le fournisseur**.
 *
 * C'est le juge de paix du livrable : notre comptage n'a de valeur que comparé
 * à ce que le fournisseur débite réellement.
 *
 * @returns le solde en dollars, ou `null` si l'endpoint ne le donne pas
 */
async function balance(): Promise<number | null> {
  const res = await fetch('https://api.venice.ai/api/v1/api_keys/rate_limits', {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) return null
  const body = (await res.json()) as { data?: { balances?: Record<string, number> } }
  const usd = body.data?.balances?.USD
  return typeof usd === 'number' ? usd : null
}

/**
 * Attend qu'une tâche se termine, en enchaînant les attentes comme le ferait Claude.
 *
 * **25 secondes par attente, pas 60.** Le client du SDK n'envoie aucun jeton de
 * progression, donc le serveur ne peut pas le tenir éveillé, et il coupe à
 * 60 s — c'est précisément ce que mesure le scénario S5 de `test:wait`. Une
 * attente de 60 s tombe pile sur la coupure. Claude, lui, fournit un jeton de
 * progression et peut demander 300 s sans risque.
 */
async function runToEnd(client: Client, taskId: string, maxWaits = 14): Promise<Record<string, any>> {
  let last: Record<string, any> = {}
  for (let i = 0; i < maxWaits; i++) {
    last = payload(await client.callTool({ name: 'harness_wait_for_task', arguments: { task_id: taskId, timeout_s: 25 } }))
    if (last.next_action !== 'call_wait_for_task_again') return last
  }
  return last
}

/**
 * Somme ce que le harness a compté sur **toutes** les tâches de cet essai.
 *
 * Cumuler scénario par scénario paraissait plus simple ; c'était faux. Une
 * tâche dont l'attente échoue continue de tourner côté daemon — et de dépenser.
 * Son coût manquait alors au total, et l'écart avec le solde débité accusait le
 * comptage pour une erreur du test. On interroge donc le registre du daemon,
 * qui est de toute façon la source de vérité.
 */
async function coutCompte(): Promise<{ total: number; taches: number }> {
  const { body } = await daemonJson<{ tasks: { usage: { cost_usd: number } }[] }>(rt!, '/api/tasks?limit=500')
  return {
    total: body.tasks.reduce((sum, t) => sum + (t.usage?.cost_usd ?? 0), 0),
    taches: body.tasks.length,
  }
}

// --- Montage ----------------------------------------------------------------
const client = await connect('essai-reel')
// Un premier appel démarre le daemon et publie son fichier de découverte.
await client.callTool({ name: 'harness_ping', arguments: {} })
const rt = readRuntime(config.runtimeFile)
if (!rt) {
  console.error('le daemon n\'a pas démarré')
  process.exit(1)
}

// On déclare le fournisseur dans le dossier jetable, avec la clé lue du coffre
// de l'utilisateur. Elle sera déposée dans le coffre **fichier** de l'essai.
const declared = await daemonJson<{ provider?: ProviderConfig; error?: string }>(rt, '/api/providers', {
  method: 'POST',
  body: JSON.stringify({ id: PROVIDER_ID, preset: 'venice', default_model: MODEL, api_key: apiKey }),
})
if (declared.status !== 200) {
  console.error('déclaration du fournisseur refusée :', declared.body.error)
  process.exit(1)
}

const soldeAvant = await balance()
console.log(`Solde Venice avant l'essai : ${soldeAvant === null ? 'inconnu' : `${soldeAvant.toFixed(6)} $`}`)
console.log(`Modèle : ${MODEL} · budget par tâche : ${BUDGET_USD} $`)
console.log()


// --- L1 ---------------------------------------------------------------------
await scenario(outcomes, 'L1 le Researcher est annoncé disponible, et il l\'est', async () => {
  const res = payload(await client.callTool({ name: 'harness_list_agents', arguments: {} }))
  const researcher = (res.agents as any[]).find((a) => a.agent_id === 'researcher')
  if (!researcher) return { verdict: 'FAIL', detail: 'profil researcher absent de la liste' }
  if (!researcher.enabled) {
    return { verdict: 'FAIL', detail: `annoncé désactivé : ${researcher.disabled_because}` }
  }
  const test = await daemonJson<{ test: { ok: boolean; detail: string } }>(
    rt,
    `/api/providers/${PROVIDER_ID}/test`,
    { method: 'POST' },
  )
  return {
    verdict: test.body.test.ok ? 'PASS' : 'FAIL',
    detail: `researcher actif, outils : ${researcher.tools.length} — ${test.body.test.detail}`,
  }
})

// --- L2 ---------------------------------------------------------------------
let tacheProjet: Record<string, any> = {}
await scenario(outcomes, 'L2 une vraie tâche aboutit à un résultat structuré', async () => {
  const start = payload(
    await client.callTool({
      name: 'harness_delegate_task',
      arguments: {
        objective:
          'What is the minimum Node.js version this repository requires, and why exactly that version? ' +
          'Answer from the repository files only. Cite the files you read.',
        agent_id: 'researcher',
        context:
          'This is the Midgaard repository. The answer is stated in README.md and justified in docs/SLICE1.md. ' +
          'Do not search the web for this one.',
        max_cost_usd: BUDGET_USD,
        max_steps: 8,
      },
    }),
  )
  if (!start.task_id) return { verdict: 'FAIL', detail: `délégation refusée : ${start.message ?? start.isError}` }

  tacheProjet = await runToEnd(client, start.task_id)
  if (tacheProjet.next_action !== 'result_ready') {
    return { verdict: 'FAIL', detail: `${tacheProjet.status} — ${tacheProjet.error ?? 'sans résultat'}` }
  }
  const u = tacheProjet.usage
  const resume = String(tacheProjet.result?.summary ?? '').slice(0, 110)
  return {
    verdict: 'PASS',
    detail: `${u.model_calls} appel(s), ${u.cost_usd} $ (${u.cost_source}) — « ${resume}… »`,
  }
})

// --- L4 (avant L3 : il faut que toutes les dépenses soient faites) ----------
await scenario(outcomes, 'L4 un budget volontairement bas arrête la tâche', async () => {
  const start = payload(
    await client.callTool({
      name: 'harness_delegate_task',
      arguments: {
        objective: 'List every TypeScript file in this repository and summarise what each one does.',
        agent_id: 'researcher',
        context: 'Deliberately broad: this task is meant to exhaust its budget.',
        // Un budget au ras du premier appel : le second ne doit pas partir.
        max_cost_usd: 0.000001,
        max_steps: 8,
      },
    }),
  )
  if (!start.task_id) return { verdict: 'FAIL', detail: 'délégation refusée' }
  const fin = await runToEnd(client, start.task_id)
  if (fin.status !== 'budget_exceeded') {
    return { verdict: 'FAIL', detail: `statut ${fin.status} au lieu de budget_exceeded` }
  }
  return {
    verdict: fin.usage.model_calls === 1 ? 'PASS' : 'FAIL',
    detail: `${fin.usage.model_calls} appel(s) modèle avant l'arrêt — « ${fin.error} »`,
  }
})

// --- L5 ---------------------------------------------------------------------
await scenario(outcomes, 'L5 ce qui revient du web remonte encadré, avec ses sources', async () => {
  const start = payload(
    await client.callTool({
      name: 'harness_delegate_task',
      arguments: {
        objective: 'Which Node.js release lines are currently in Active LTS? Answer in one sentence, with sources.',
        agent_id: 'researcher',
        context: 'You will need the web for this one; the repository does not contain the answer.',
        max_cost_usd: BUDGET_USD,
        max_steps: 6,
      },
    }),
  )
  if (!start.task_id) return { verdict: 'FAIL', detail: 'délégation refusée' }
  const fin = await runToEnd(client, start.task_id)
  if (fin.next_action !== 'result_ready') {
    return { verdict: 'CONSTAT', detail: `${fin.status} — ${fin.error ?? 'sans résultat'}` }
  }
  const resultat = payload(await client.callTool({ name: 'harness_get_task_result', arguments: { task_id: start.task_id } }))
  const details = String(resultat.result?.details ?? '')
  const citations = (resultat.result?.citations ?? []) as { url: string }[]
  const encadre = /<untrusted_data nonce="[0-9a-f]{16}"/.test(details)
  if (citations.length === 0) {
    return { verdict: 'CONSTAT', detail: 'le modèle n\'a cité aucune source : rien à encadrer' }
  }
  return {
    verdict: encadre ? 'PASS' : 'FAIL',
    detail: `${citations.length} source(s), encadrement ${encadre ? 'présent' : 'ABSENT'} — ${citations[0]?.url ?? ''}`,
  }
})

// --- L3 : le juge de paix ---------------------------------------------------
await scenario(outcomes, 'L3 le coût affiché correspond au solde débité', async () => {
  if (soldeAvant === null) return { verdict: 'CONSTAT', detail: 'solde indisponible avant l\'essai' }
  // Le solde peut mettre un instant à refléter les derniers appels.
  await sleep(4000)
  const soldeApres = await balance()
  if (soldeApres === null) return { verdict: 'CONSTAT', detail: 'solde indisponible après l\'essai' }

  const { total: compte, taches } = await coutCompte()
  const debite = soldeAvant - soldeApres
  const ecart = Math.abs(debite - compte)
  const relatif = debite === 0 ? (compte === 0 ? 0 : 1) : ecart / debite
  const detail =
    `${taches} tâche(s) : compté ${compte.toFixed(6)} $, débité ${debite.toFixed(6)} $ ` +
    `(${soldeAvant.toFixed(6)} → ${soldeApres.toFixed(6)}), écart ${(relatif * 100).toFixed(1)} %`
  // 2 % de tolérance : les arrondis du fournisseur et notre somme de nombres
  // flottants ne tomberont jamais au centième de centime près.
  return { verdict: relatif <= 0.02 ? 'PASS' : 'FAIL', detail }
})

await client.close()
cleanup()
process.exitCode = summarize(outcomes, 'Essai réel — agents Venice')
