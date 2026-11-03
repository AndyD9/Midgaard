/**
 * @file Faux fournisseur de modèle compatible OpenAI, pour les suites qui
 * éprouvent un agent réel sans réseau ni dépense (`test:developer`, `test:ui`).
 *
 * Il **joue un scénario** : à chaque tour, il rend l'appel d'outil prévu pour la
 * tâche dont l'objectif porte l'étiquette du scénario. Le numéro du tour est le
 * nombre de messages d'assistant déjà dans la conversation : le serveur n'a
 * aucun état, et une requête rejouée rend la même réponse.
 *
 * Rien d'autre n'est simulé : le daemon, la boucle, les outils et Git sont les
 * vrais. `test:live` reste la seule suite à parler à un vrai modèle.
 *
 * **Un seul trou dans le script : l'identifiant d'une sous-tâche** (Slice 5).
 * Un orchestrateur attend la sous-tâche qu'il vient de déléguer, dont
 * l'identifiant n'existe pas quand le scénario s'écrit. Une valeur d'argument
 * égale à `{{task_id}}` est remplacée par le dernier `task_id` lu dans un
 * résultat d'outil de la conversation, `{{task_id:N}}` par le N-ième (à partir
 * de 0, dans l'ordre d'apparition) — ce que ferait le modèle. Le serveur reste
 * sans état : la conversation porte tout.
 */
import { createServer, type Server } from 'node:http'

/** Un tour du modèle : des appels d'outils, ou du texte seul. */
export type Turn = { tool: string; args: Record<string, unknown> }[] | { text: string }

/** Un faux fournisseur démarré, et ses scénarios par étiquette. */
export interface FakeProvider {
  server: Server
  /** `base_url` à déclarer avec le préréglage `custom`. */
  url: string
  /** Scénarios, par étiquette présente dans l'objectif de la tâche. */
  scripts: Map<string, Turn[]>
  /**
   * Consigne système reçue au premier tour, par étiquette : ce que le daemon a
   * réellement dit à l'agent, pour vérifier ce qu'aucune réponse ne montre.
   */
  systems: Map<string, string>
  /**
   * Dernière conversation reçue, par étiquette : ce que l'agent a réellement
   * lu, message par message (Slice 6) — par exemple un message de
   * l'utilisateur, dont on vérifie qu'il arrive expurgé.
   */
  received: Map<string, { role: string; content: string | null }[]>
}

/** Rend le tour suivant du scénario de la tâche, au format de `/chat/completions`. */
function completion(
  scripts: Map<string, Turn[]>,
  systems: Map<string, string>,
  received: FakeProvider['received'],
  body: { messages?: { role: string; content: string | null }[] },
): unknown {
  const messages = body.messages ?? []
  const user = messages.find((m) => m.role === 'user')?.content ?? ''
  const tag = [...scripts.keys()].find((t) => user.includes(t))
  if (tag && !systems.has(tag)) systems.set(tag, messages.find((m) => m.role === 'system')?.content ?? '')
  if (tag) received.set(tag, messages)
  const turn = tag ? scripts.get(tag)![messages.filter((m) => m.role === 'assistant').length] : undefined
  // Les identifiants de sous-tâche rendus par les outils, dans l'ordre où ils
  // sont apparus, chacun une fois.
  const taskIds = [
    ...new Set(
      messages
        .filter((m) => m.role === 'tool')
        .map((m) => /"task_id":\s*"([0-9a-f-]{36})"/.exec(m.content ?? '')?.[1])
        .filter((id): id is string => id !== undefined),
    ),
  ]
  const fill = (v: unknown): unknown => {
    if (v === '{{task_id}}') return taskIds.at(-1) ?? v
    const nth = typeof v === 'string' ? /^\{\{task_id:(\d+)\}\}$/.exec(v) : null
    return nth ? (taskIds[Number(nth[1])] ?? v) : v
  }
  const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
  if (!turn || 'text' in turn) {
    const content = turn && 'text' in turn ? turn.text : 'fin du scénario'
    return { id: 'faux', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage }
  }
  return {
    id: 'faux',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: turn.map((c, i) => ({
            id: `appel-${i}-${Math.random().toString(36).slice(2, 8)}`,
            type: 'function',
            function: {
              name: c.tool,
              arguments: JSON.stringify(
                Object.fromEntries(Object.entries(c.args).map(([k, v]) => [k, fill(v)])),
              ),
            },
          })),
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage,
  }
}

/** Démarre le faux fournisseur sur un port libre de la boucle locale. */
export async function startFakeProvider(): Promise<FakeProvider> {
  const scripts = new Map<string, Turn[]>()
  const systems = new Map<string, string>()
  const received: FakeProvider['received'] = new Map()
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      if (req.url?.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'faux-1' }] }))
      res.end(JSON.stringify(completion(scripts, systems, received, JSON.parse(raw || '{}'))))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { server, url: `http://127.0.0.1:${port}/v1`, scripts, systems, received }
}
