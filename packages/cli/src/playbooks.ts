/**
 * @file Commande `harness playbooks` (Slice 9, étape 1) : lister les
 * playbooks du clone, en attacher un à un profil, le lui retirer.
 *
 * Tout passe par l'API du daemon, comme `harness mcp` : c'est lui qui lit le
 * dossier des playbooks — celui de **son** installation, ou celui que désigne
 * `MIDGAARD_PLAYBOOKS_DIR` —, et c'est lui qui vérifie qu'un playbook existe
 * et tient dans les bornes avant de l'attacher.
 *
 * Attacher ne demande pas de confirmation, contrairement à `exec allow` ou
 * `mcp allow` : un playbook n'ouvre aucune porte. Il ajoute du texte écrit
 * par un humain à une consigne, après les règles du profil, qu'il ne peut
 * pas remplacer (docs/SLICE9.md, décision 3). Ce qu'il coûte se dit en
 * revanche à l'attache : il est relu à chaque appel de modèle.
 */
import { daemonJson, type Agent, type HarnessConfig, type PlaybooksResponse } from '@midgaard/contracts'
import { ensureDaemon } from '@midgaard/mcp-server'
import { bold, cmd, dim, green, red, yellow } from './ui.ts'

/** Journalisation discrète du démarrage de daemon : la CLI a sa propre sortie. */
const quiet = () => {}

/** Ce que le daemon rend en cas de refus. */
type Refused = {
  error?: string
  reason?: string
  /** `playbook_not_found` : les identifiants inconnus ; `playbook_unusable` : chacun avec son motif. */
  playbooks?: (string | { id: string; reason: string })[]
  available?: string[]
  dir?: string
  bytes?: number
  max_bytes?: number
}

/**
 * Affiche un refus du daemon — même forme que `harness mcp` —, et ce qui
 * aurait été accepté quand il le dit.
 */
function refused(status: number, body: Refused): number {
  console.error(`${red('✘')} ${body.error ?? status}${body.reason ? ` — ${body.reason}` : ''}`)
  for (const p of body.playbooks ?? []) {
    console.error(dim(typeof p === 'string' ? `  inconnu : ${p}` : `  ${p.id} : ${p.reason}`))
  }
  if (body.available) {
    console.error(dim(`Disponibles${body.dir ? ` dans ${body.dir}` : ''} : ${body.available.join(', ') || '(aucun)'}`))
  }
  if (body.bytes !== undefined && body.max_bytes !== undefined) {
    console.error(dim(`  ${size(body.bytes)} ensemble, au plus ${size(body.max_bytes)} par profil`))
  }
  return 1
}

/** Répartit les sous-commandes de `harness playbooks`. */
export async function playbooks(config: HarnessConfig, args: string[]): Promise<number> {
  const [sub = 'list', ...rest] = args
  switch (sub) {
    case 'list':
      return list(config)
    case 'attach':
      return attach(config, rest[0], rest[1], true)
    case 'detach':
      return attach(config, rest[0], rest[1], false)
    default:
      console.error(`Sous-commande inconnue : playbooks ${sub}`)
      console.error('Attendu : list, attach, detach')
      return 1
  }
}

/** Taille lisible par un humain : un playbook se compte en kilo-octets. */
function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} o` : `${(bytes / 1024).toFixed(1)} Kio`
}

/**
 * Les playbooks du dossier, ce qu'ils pèsent, et les profils qui les ont. Un
 * playbook inutilisable est listé avec son motif : sinon l'humain qui l'a
 * écrit ne saurait pas pourquoi l'attache le refuse.
 */
async function list(config: HarnessConfig): Promise<number> {
  const rt = await ensureDaemon(config, quiet)
  const listed = await daemonJson<PlaybooksResponse & Refused>(rt, '/api/playbooks')
  if (listed.status !== 200) return refused(listed.status, listed.body)
  const agents = await daemonJson<{ agents: Agent[] }>(rt, '/api/agents')
  const owners = (id: string) => (agents.body.agents ?? []).filter((a) => a.playbooks.includes(id)).map((a) => a.id)

  console.log(dim(`Dossier : ${listed.body.dir}`))
  if (listed.body.playbooks.length === 0) {
    console.log('Aucun playbook.')
    return 0
  }
  for (const p of listed.body.playbooks) {
    const mark = p.unusable_reason ? red('✘') : green('●')
    console.log(`${mark} ${bold(p.id)} — ${p.title} ${dim(`(${size(p.bytes)}, sha256 ${p.sha256.slice(0, 12)})`)}`)
    if (p.unusable_reason) console.log(`  ${yellow(`inutilisable : ${p.unusable_reason}`)}`)
    const who = owners(p.id)
    console.log(`  ${dim(who.length ? `attaché à : ${who.join(', ')}` : 'attaché à aucun profil')}`)
  }
  // L'exemple nomme un playbook **qui existe** et un profil qui peut le
  // recevoir : la première version citait `sigma`, absent du dossier, et
  // conseillait donc une commande qui échoue (constaté sur la vraie CLI).
  const usable = listed.body.playbooks.find((p) => p.unusable_reason === null)
  const target = (agents.body.agents ?? []).find((a) => a.kind !== 'simulated' && usable && !a.playbooks.includes(usable.id))
  if (usable && target) console.log(dim(`Attacher : ${cmd(`playbooks attach ${usable.id} ${target.id}`)}`))
  return 0
}

/**
 * Attache un playbook à un profil, ou le lui retire, à partir de la tâche
 * suivante. La route prend la liste complète et ordonnée ; la CLI la relit et
 * n'y change que ce playbook-là, ajouté à la fin.
 */
async function attach(config: HarnessConfig, playbook: string | undefined, agentId: string | undefined, on: boolean): Promise<number> {
  if (!playbook || !agentId) {
    console.error(`Usage : playbooks ${on ? 'attach' : 'detach'} <playbook> <profil>`)
    return 1
  }
  const rt = await ensureDaemon(config, quiet)
  const current = await daemonJson<{ agent?: Agent } & Refused>(rt, `/api/agents/${encodeURIComponent(agentId)}`)
  if (current.status !== 200 || !current.body.agent) return refused(current.status, current.body)
  const before = current.body.agent.playbooks
  if (on === before.includes(playbook)) {
    console.log(`${bold(agentId)} ${on ? 'a déjà' : 'n\'a pas'} le playbook ${bold(playbook)} : rien n'a changé.`)
    return 0
  }
  const next = on ? [...before, playbook] : before.filter((p) => p !== playbook)
  const { status, body } = await daemonJson<{ agent?: Agent } & Refused>(
    rt,
    `/api/agents/${encodeURIComponent(agentId)}/playbooks`,
    { method: 'PUT', body: JSON.stringify({ playbooks: next }) },
  )
  if (status !== 200 || !body.agent) return refused(status, body)
  console.log(
    on
      ? `${green('✔')} ${bold(playbook)} ajouté à la consigne de ${bold(agentId)} ${dim('— à partir de la tâche suivante')}`
      : `${green('✔')} ${bold(playbook)} retiré du profil ${bold(agentId)}`,
  )
  if (on) console.log(dim('Relu à chaque appel de modèle de ses tâches : il se paie à chaque appel.'))
  return 0
}
