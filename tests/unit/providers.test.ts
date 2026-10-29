/**
 * @file Normalisation des deux adaptateurs, et calcul du coût.
 *
 * Ces tests ne joignent aucun fournisseur : ils montent un serveur HTTP local
 * qui rejoue des réponses enregistrées d'après les documentations officielles.
 * C'est volontaire et c'est ce qui les rend utiles — ils vérifient **notre**
 * traduction, pas la disponibilité d'un service tiers. Un test qui appelle une
 * vraie API échoue le jour où le réseau tombe, coûte de l'argent à chaque
 * exécution, et ne dit rien de plus sur le code qu'on écrit.
 *
 * Les pièges couverts sont ceux qui coûtent cher et ne se voient pas :
 *  - les jetons de pensée de Gemini, facturés sans figurer dans la sortie ;
 *  - le coût annoncé par Venice, qui doit l'emporter sur notre estimation ;
 *  - un modèle sans tarif connu, qui ne doit **pas** afficher zéro.
 */
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { after, before, describe, it } from 'node:test'
import type { PricingTable } from '@midgaard/contracts'
import { addUsage, emptyUsage } from '@midgaard/contracts'
import { createGeminiAdapter, createOpenAiAdapter, priceFor } from '@midgaard/providers'

/** Dernière requête reçue, pour vérifier ce qu'on envoie et pas seulement ce qu'on lit. */
let lastRequest: { path: string; body: Record<string, unknown>; auth: string | undefined }
/** Réponse que le faux serveur rendra au prochain appel. */
let nextResponse: unknown = {}
let server: Server
let base = ''

/**
 * Réponses des routes `GET`, par chemin : `[code, corps]`.
 *
 * Séparées de `nextResponse`, qui sert aux complétions : un test de connexion
 * interroge deux chemins différents, dont l'un doit pouvoir refuser pendant que
 * l'autre accepte.
 */
const getRoutes = new Map<string, [number, unknown]>()

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      lastRequest = {
        path: req.url ?? '',
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
        auth: req.headers.authorization ?? (req.headers['x-goog-api-key'] as string | undefined),
      }
      const route = req.method === 'GET' ? getRoutes.get((req.url ?? '').split('?')[0] ?? '') : undefined
      if (route) {
        res.writeHead(route[0], { 'content-type': 'application/json' })
        return res.end(JSON.stringify(route[1]))
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(nextResponse))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => server.close())

const PRICING: PricingTable = {
  updated_at: new Date().toISOString(),
  source: 'test',
  entries: {
    'venice:modele-tarife': {
      input_usd_per_mtok: 1,
      output_usd_per_mtok: 10,
      cached_input_usd_per_mtok: 0.1,
      web_search_usd_per_call: 0.01,
    },
    'gemini:modele-tarife': {
      input_usd_per_mtok: 1,
      output_usd_per_mtok: 10,
      cached_input_usd_per_mtok: null,
      web_search_usd_per_call: null,
    },
  },
}

const redact = (t: string) => t

function venice(model = 'modele-tarife') {
  return createOpenAiAdapter({
    id: 'venice',
    preset: 'venice',
    model,
    baseUrl: base,
    apiKey: 'sk-test-0123456789abcdef',
    webSearch: true,
    redact,
    price: priceFor(PRICING, 'venice', model),
  })
}

function gemini(model = 'modele-tarife') {
  return createGeminiAdapter({
    id: 'gemini',
    model,
    apiKey: 'AIza-test',
    baseUrl: base,
    webSearch: false,
    redact,
    price: priceFor(PRICING, 'gemini', model),
  })
}

const ASK = { messages: [{ role: 'user' as const, content: 'bonjour' }], tools: [], maxOutputTokens: 512, webSearch: false }

describe('adaptateur compatible OpenAI', () => {
  it('normalise texte, appels d\'outils et consommation', async () => {
    nextResponse = {
      choices: [
        {
          message: {
            content: 'je regarde',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 200,
        completion_tokens_details: { reasoning_tokens: 50 },
        prompt_tokens_details: { cached_tokens: 400 },
      },
    }
    const res = await venice().complete(ASK)
    assert.equal(res.text, 'je regarde')
    assert.equal(res.finishReason, 'tool_calls')
    assert.deepEqual(res.toolCalls, [{ id: 'call_1', name: 'read_file', argumentsJson: '{"path":"a.ts"}' }])
    assert.equal(res.usage.input_tokens, 1000)
    assert.equal(res.usage.output_tokens, 200)
    assert.equal(res.usage.reasoning_tokens, 50)
    assert.equal(res.usage.cached_tokens, 400)
  })

  it('calcule le coût depuis la table quand le fournisseur n\'en annonce pas', async () => {
    nextResponse = { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 } }
    const res = await venice().complete(ASK)
    // 1 M d'entrée à 1 $ + 1 M de sortie à 10 $ = 11 $
    assert.equal(res.usage.cost_usd, 11)
    assert.equal(res.usage.cost_source, 'pricing_table')
    assert.equal(res.usage.cost_usd_reported, null)
  })

  it('facture les jetons de cache au tarif réduit, sans les compter deux fois', async () => {
    nextResponse = {
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1_000_000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 1_000_000 } },
    }
    const res = await venice().complete(ASK)
    // Tout l'entrée vient du cache : 1 M à 0,10 $, et non 1 $ ni 1,10 $.
    assert.equal(res.usage.cost_usd, 0.1)
  })

  it('retient le coût annoncé par le fournisseur, et garde l\'estimation à côté', async () => {
    nextResponse = {
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
      cost: { usd: 9.5, diem: 9.5 },
    }
    const res = await venice().complete(ASK)
    assert.equal(res.usage.cost_usd, 9.5, 'la facture du fournisseur l\'emporte')
    assert.equal(res.usage.cost_source, 'provider')
    assert.equal(res.usage.cost_usd_estimated, 11, 'notre estimation reste visible : son écart révèle une table périmée')
  })

  it('n\'invente aucun montant pour un modèle sans tarif connu', async () => {
    nextResponse = { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5000, completion_tokens: 5000 } }
    const res = await venice('modele-inconnu-au-bataillon').complete(ASK)
    assert.equal(res.usage.cost_source, 'unknown')
    assert.equal(res.usage.cost_usd_estimated, null, 'null et non 0 : zéro est un coût, pas une ignorance')
  })

  it('remonte les citations de la recherche web et compte la requête', async () => {
    nextResponse = {
      choices: [{ message: { content: 'selon mes sources' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 10 },
      venice_parameters: {
        web_search_citations: [{ title: 'Doc officielle', url: 'https://example.org/doc', content: '…' }],
      },
    }
    const res = await venice().complete({ ...ASK, webSearch: true })
    assert.deepEqual(res.citations, [{ title: 'Doc officielle', url: 'https://example.org/doc' }])
    assert.equal(res.usage.web_searches, 1)
    assert.equal(lastRequest.body.venice_parameters && (lastRequest.body.venice_parameters as Record<string, unknown>).enable_web_search, 'auto')
  })

  it('emploie max_tokens pour Venice et max_completion_tokens pour OpenAI', async () => {
    nextResponse = { choices: [{ message: { content: '' }, finish_reason: 'stop' }], usage: {} }
    await venice().complete(ASK)
    assert.equal(lastRequest.body.max_tokens, 512)
    assert.equal(lastRequest.body.max_completion_tokens, undefined, 'Venice refuse en 400 tout champ inconnu')

    const openai = createOpenAiAdapter({
      id: 'openai', preset: 'openai', model: 'm', baseUrl: base, apiKey: 'sk-x',
      webSearch: false, redact, price: undefined,
    })
    await openai.complete(ASK)
    assert.equal(lastRequest.body.max_completion_tokens, 512)
    assert.equal(lastRequest.body.max_tokens, undefined)
    assert.equal(lastRequest.body.venice_parameters, undefined, 'pas d\'extension Venice hors de Venice')
  })

  it('renvoie un message d\'assistant avec ses tool_calls, sinon l\'API refuse la suite', async () => {
    nextResponse = { choices: [{ message: { content: 'fini' }, finish_reason: 'stop' }], usage: {} }
    await venice().complete({
      ...ASK,
      messages: [
        { role: 'user', content: 'lis a.ts' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read_file', argumentsJson: '{}' }] },
        { role: 'tool', callId: 'call_1', name: 'read_file', content: 'contenu' },
      ],
    })
    const sent = lastRequest.body.messages as Record<string, unknown>[]
    assert.equal((sent[1] as { tool_calls?: unknown[] }).tool_calls?.length, 1)
    assert.equal((sent[2] as { tool_call_id?: string }).tool_call_id, 'call_1')
  })
})

describe('adaptateur Gemini', () => {
  it('sort la consigne système de la conversation et traduit les rôles', async () => {
    nextResponse = { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: {} }
    await gemini().complete({
      ...ASK,
      messages: [
        { role: 'system', content: 'tu es un chercheur' },
        { role: 'user', content: 'bonjour' },
        { role: 'assistant', content: 'salut', toolCalls: [] },
      ],
    })
    const system = lastRequest.body.systemInstruction as { parts: { text: string }[] }
    assert.equal(system.parts[0]?.text, 'tu es un chercheur')
    const contents = lastRequest.body.contents as { role: string }[]
    assert.deepEqual(contents.map((c) => c.role), ['user', 'model'], 'pas de rôle system, et assistant → model')
  })

  it('traduit functionCall, dont les arguments sont déjà désérialisés', async () => {
    nextResponse = {
      candidates: [
        { content: { parts: [{ functionCall: { name: 'read_file', args: { path: 'a.ts' } } }] }, finishReason: 'STOP' },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    }
    const res = await gemini().complete(ASK)
    assert.equal(res.toolCalls.length, 1)
    assert.equal(res.toolCalls[0]!.argumentsJson, '{"path":"a.ts"}')
    assert.equal(res.finishReason, 'tool_calls', 'Gemini rend STOP même avec un appel d\'outil : on le déduit du contenu')
  })

  it('ajoute les jetons de pensée à la sortie — sans quoi la facture est sous-estimée', async () => {
    nextResponse = {
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 500_000, thoughtsTokenCount: 500_000 },
    }
    const res = await gemini().complete(ASK)
    assert.equal(res.usage.output_tokens, 1_000_000, 'pensée + sortie, car Google facture les deux au tarif de sortie')
    assert.equal(res.usage.reasoning_tokens, 500_000, 'la part de pensée reste visible')
    assert.equal(res.usage.cost_usd, 10, 'et elle est facturée une seule fois')
  })

  it('traduit un retour d\'outil en functionResponse de rôle user', async () => {
    nextResponse = { candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'STOP' }], usageMetadata: {} }
    await gemini().complete({
      ...ASK,
      messages: [{ role: 'tool', callId: 'ignoré par Gemini', name: 'read_file', content: 'contenu' }],
    })
    const contents = lastRequest.body.contents as { role: string; parts: { functionResponse?: { name: string } }[] }[]
    assert.equal(contents[0]!.role, 'user')
    assert.equal(contents[0]!.parts[0]!.functionResponse?.name, 'read_file')
  })

  it('passe la clé par un en-tête, jamais dans l\'URL', async () => {
    nextResponse = { candidates: [], usageMetadata: {} }
    await gemini().complete(ASK)
    assert.equal(lastRequest.auth, 'AIza-test')
    assert.ok(!lastRequest.path.includes('AIza'), 'une URL finit dans les journaux de tout ce qu\'elle traverse')
  })
})

describe('cumul des consommations', () => {
  it('dégrade la source dès qu\'un appel n\'est pas facturé par le fournisseur', () => {
    const facture = { ...emptyUsage(), model_calls: 1, cost_usd: 1, cost_source: 'provider' as const, cost_usd_reported: 1 }
    const estime = { ...emptyUsage(), model_calls: 1, cost_usd: 2, cost_source: 'pricing_table' as const, cost_usd_estimated: 2 }
    const inconnu = { ...emptyUsage(), model_calls: 1, cost_source: 'unknown' as const }

    assert.equal(addUsage(facture, facture).cost_source, 'provider')
    assert.equal(addUsage(facture, estime).cost_source, 'pricing_table', 'un total mi-facturé n\'est pas une facture')
    assert.equal(addUsage(estime, inconnu).cost_source, 'unknown', 'un seul tarif manquant rend le total inconnu')
    assert.equal(addUsage(emptyUsage(), facture).cost_source, 'provider', 'un cumul vide n\'est pas une ignorance')
    assert.equal(addUsage(facture, estime).cost_usd, 3)
  })
})

describe('test de connexion', () => {
  it('refuse une clé que le fournisseur rejette, même si /models répond', async () => {
    // Le piège, mesuré sur la vraie API : `GET /models` de Venice répond 200
    // SANS aucune clé. Un test qui s'y fierait annoncerait « joignable » à
    // quelqu'un dont la clé est fausse, et l'erreur n'apparaîtrait qu'à la
    // première tâche — loin de sa cause.
    getRoutes.set('/models', [200, { data: [{ id: 'modele-tarife' }] }])
    getRoutes.set('/api_keys/rate_limits', [401, { error: 'Authentication failed' }])
    const test = await venice().testConnection()
    assert.equal(test.ok, false)
    assert.match(test.detail, /clé refusée/)
  })

  it('confirme une clé acceptée, et rapporte le solde quand il est donné', async () => {
    getRoutes.set('/models', [200, { data: [{ id: 'modele-tarife' }, { id: 'autre' }] }])
    getRoutes.set('/api_keys/rate_limits', [200, { data: { balances: { USD: 12.5 } } }])
    const test = await venice().testConnection()
    assert.equal(test.ok, true)
    assert.match(test.detail, /2 modèle\(s\) disponibles, dont « modele-tarife »/)
    assert.match(test.detail, /solde USD 12\.5/)
  })

  it('signale un modèle configuré que le fournisseur ne propose pas', async () => {
    getRoutes.set('/models', [200, { data: [{ id: 'un-autre-modele' }] }])
    getRoutes.set('/api_keys/rate_limits', [200, {}])
    const test = await venice().testConnection()
    assert.equal(test.ok, true, 'l\'endpoint répond et la clé est bonne : ce n\'est pas un échec de connexion')
    assert.match(test.detail, /n'en fait pas partie/)
  })

  it('ne sonde pas d\'endpoint supplémentaire pour OpenAI, dont /models exige déjà la clé', async () => {
    getRoutes.set('/models', [200, { data: [{ id: 'm' }] }])
    getRoutes.set('/api_keys/rate_limits', [401, { error: 'ne doit pas être appelé' }])
    const openai = createOpenAiAdapter({
      id: 'openai', preset: 'openai', model: 'm', baseUrl: base, apiKey: 'sk-x',
      webSearch: false, redact, price: undefined,
    })
    const test = await openai.testConnection()
    assert.equal(test.ok, true)
    assert.equal(lastRequest.path.split('?')[0], '/models', 'dernier appel : /models, pas la sonde Venice')
  })
})
