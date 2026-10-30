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
}

/** Rend le tour suivant du scénario de la tâche, au format de `/chat/completions`. */
function completion(scripts: Map<string, Turn[]>, body: { messages?: { role: string; content: string | null }[] }): unknown {
  const messages = body.messages ?? []
  const user = messages.find((m) => m.role === 'user')?.content ?? ''
  const tag = [...scripts.keys()].find((t) => user.includes(t))
  const turn = tag ? scripts.get(tag)![messages.filter((m) => m.role === 'assistant').length] : undefined
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
            function: { name: c.tool, arguments: JSON.stringify(c.args) },
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
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      if (req.url?.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'faux-1' }] }))
      res.end(JSON.stringify(completion(scripts, JSON.parse(raw || '{}'))))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { server, url: `http://127.0.0.1:${port}/v1`, scripts }
}
