/**
 * @file Commande `harness windows` (Slice 9, étapes 5.2 et 5.3) : déclarer la
 * VM Windows de test, la tester, relire sa clé publique, la retirer, et
 * l'attacher à un profil Developer ou l'en détacher.
 *
 * Tout passe par l'API du daemon : c'est lui qui **génère la clé** et la garde
 * au coffre. La CLI n'en voit jamais que la moitié publique, et l'affiche avec
 * la commande PowerShell qui la pose sur la VM.
 *
 * L'empreinte d'hôte est **recopiée depuis la console de la VM** (décision du
 * troisième tour) : à la première déclaration, sans `--fingerprint`, la CLI
 * refuse et dit comment la lire, plutôt que de faire confiance au premier
 * contact.
 *
 * L'attache (5.3) ne donne encore aucun outil à l'agent : la CLI le dit, pour
 * ne pas décrire une capacité qui n'existe pas encore.
 */
import {
  daemonJson,
  WINDOWS_FINGERPRINT_COMMAND,
  WINDOWS_SSHD_COMMANDS,
  type Agent,
  type AgentsResponse,
  type HarnessConfig,
  type WindowsHostResponse,
  type WindowsHostsResponse,
  type WindowsHostView,
} from '@midgaard/contracts'
import { ensureDaemon } from '@midgaard/mcp-server'
import { bold, cmd, dim, green, red, yellow } from './ui.ts'

/** Journalisation discrète du démarrage de daemon : la CLI a sa propre sortie. */
const quiet = () => {}

/** Ce que décrit `windows add`, avant tout appel au daemon. */
export interface WindowsAddArgs {
  id: string
  host?: string | undefined
  user?: string | undefined
  port?: number | undefined
  name?: string | undefined
  fingerprint?: string | undefined
  newKey: boolean
}

/**
 * Lit les arguments de `windows add`.
 *
 * @param args `<id> --host H --user U [--port N] [--name N] [--fingerprint "…"] [--new-key]`
 * @returns les arguments lus, ou la raison du refus
 */
export function parseWindowsAddArgs(args: string[]): WindowsAddArgs | { error: string } {
  const [id, ...rest] = args
  if (!id || id.startsWith('-')) return { error: 'il manque l\'identifiant de la VM' }
  const out: WindowsAddArgs = { id, newKey: false }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!
    const value = () => {
      const v = rest[++i]
      if (v === undefined) throw new Error(`${a} attend une valeur`)
      return v
    }
    try {
      if (a === '--host') out.host = value()
      else if (a === '--user') out.user = value()
      else if (a === '--name') out.name = value()
      else if (a === '--fingerprint') out.fingerprint = value()
      else if (a === '--new-key') out.newKey = true
      else if (a === '--port') {
        const port = Number(value())
        if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: `port invalide : ${rest[i]}` }
        out.port = port
      } else return { error: `option inconnue : ${a}` }
    } catch (e) {
      return { error: (e as Error).message }
    }
  }
  return out
}

/** Répartit les sous-commandes de `harness windows`. */
export async function windows(config: HarnessConfig, args: string[]): Promise<number> {
  const [sub = 'list', ...rest] = args
  switch (sub) {
    case 'list':
      return list(config)
    case 'add':
      return add(config, rest)
    case 'test':
      return test(config, rest[0])
    case 'key':
      return key(config, rest[0])
    case 'remove':
      return remove(config, rest[0])
    case 'attach':
      return attach(config, rest[0], rest[1])
    case 'detach':
      return detach(config, rest[0])
    default:
      console.error(`Sous-commande inconnue : windows ${sub}`)
      console.error('Attendu : list, add, test, key, remove, attach, detach')
      return 1
  }
}

/** Comment lire l'empreinte sur la VM, et activer son serveur SSH si besoin. */
function howToReadFingerprint(): void {
  console.log(`  Sur la ${bold('console de la VM')}, dans un PowerShell administrateur :`)
  console.log(`    ${WINDOWS_FINGERPRINT_COMMAND}`)
  console.log(`  ${dim('Recopie la ligne entière, ou seulement SHA256:…, dans --fingerprint.')}`)
  console.log(`  ${dim('Si le fichier n\'existe pas, le serveur OpenSSH n\'est pas installé :')}`)
  for (const line of WINDOWS_SSHD_COMMANDS) console.log(`    ${dim(line)}`)
}

/** La clé publique et les lignes qui la posent. */
function showInstall(host: WindowsHostView): void {
  console.log(`  Pose la clé de Midgaard sur la VM, dans un ${bold('PowerShell administrateur')} :`)
  for (const line of host.install_commands) console.log(`    ${line}`)
  console.log(`  ${dim(`(pour le compte administrateur ${host.username} ; la clé est dédiée à cette VM)`)}`)
}

async function list(config: HarnessConfig): Promise<number> {
  const rt = await ensureDaemon(config, quiet)
  const { status, body } = await daemonJson<WindowsHostsResponse>(rt, '/api/windows')
  if (status !== 200) {
    console.error(`${red('✘')} ${status}`)
    return 1
  }
  // Les profils qui portent chaque VM se lisent sur les profils : c'est là
  // que l'attache est rangée, une colonne par profil.
  const agents = await daemonJson<AgentsResponse>(rt, '/api/agents')
  const owners = (id: string) => (agents.status === 200 ? agents.body.agents : []).filter((a) => a.windows_host === id).map((a) => a.id)
  console.log(bold('VM Windows de test'))
  if (body.hosts.length === 0) {
    console.log(`  ${dim('aucune :')} ${cmd('windows add vm1 --host 192.168.64.5 --user analyste --fingerprint "SHA256:…"')}`)
  }
  for (const h of body.hosts) {
    const t = h.last_test
    const state = !t ? yellow('jamais testée') : t.ok ? green(`✔ ${t.detail}`) : red(`✘ ${t.detail}`)
    console.log(`  ${bold(h.id)}  ${h.username}@${h.host}:${h.port}  ${dim(h.fingerprint)}`)
    console.log(`    ${state}${t ? dim(` — ${t.at.slice(0, 16).replace('T', ' ')}`) : ''}`)
    const who = owners(h.id)
    console.log(`    ${dim(who.length ? `attachée à : ${who.join(', ')}` : 'attachée à aucun profil')}`)
  }
  return 0
}

async function add(config: HarnessConfig, rest: string[]): Promise<number> {
  const parsed = parseWindowsAddArgs(rest)
  if ('error' in parsed) {
    console.error(`${red('✘')} ${parsed.error}`)
    console.error('Usage : windows add <id> --host H --user U [--port 22] [--name N] [--fingerprint "SHA256:…"] [--new-key]')
    return 1
  }
  const rt = await ensureDaemon(config, quiet)
  const existing = await daemonJson<WindowsHostResponse>(rt, `/api/windows/${encodeURIComponent(parsed.id)}`)
  const before = existing.status === 200 ? existing.body.host : null
  const host = parsed.host ?? before?.host
  const user = parsed.user ?? before?.username
  if (!host || !user) {
    console.error(`${red('✘')} il faut --host et --user pour déclarer une VM`)
    return 1
  }
  // Refusé ici, avant le daemon qui le refuserait aussi : la réponse utile
  // est la commande qui lit l'empreinte, pas un code d'erreur.
  if (!before && !parsed.fingerprint) {
    console.error(`${red('✘')} l'empreinte d'hôte est exigée : Midgaard ne fait pas confiance au premier contact.`)
    howToReadFingerprint()
    return 1
  }
  const { status, body } = await daemonJson<WindowsHostResponse & { error?: string; reason?: string }>(rt, '/api/windows', {
    method: 'POST',
    body: JSON.stringify({
      id: parsed.id,
      host,
      username: user,
      port: parsed.port ?? before?.port ?? 22,
      ...(parsed.name ? { name: parsed.name } : {}),
      ...(parsed.fingerprint ? { fingerprint: parsed.fingerprint } : {}),
      new_key: parsed.newKey,
    }),
  })
  if (status !== 200) {
    console.error(`${red('✘')} ${body.reason ?? body.error ?? status}`)
    if (body.error === 'invalid_fingerprint') howToReadFingerprint()
    return 1
  }
  const h = body.host
  console.log(`${green('✔')} VM « ${h.id} » ${before ? 'mise à jour' : 'déclarée'} : ${h.username}@${h.host}:${h.port}, empreinte ${h.fingerprint}`)
  if (!before || parsed.newKey) {
    console.log(`  ${parsed.newKey && before ? yellow('nouvelle clé : l\'ancienne ne sert plus.') : 'Une clé ed25519 dédiée a été générée et rangée au coffre.'}`)
    showInstall(h)
  }
  console.log(`  Puis : ${cmd(`windows test ${h.id}`)}`)
  return 0
}

async function test(config: HarnessConfig, id: string | undefined): Promise<number> {
  if (!id) {
    console.error('Usage : windows test <id>')
    return 1
  }
  const rt = await ensureDaemon(config, quiet)
  const { status, body } = await daemonJson<WindowsHostResponse & { error?: string }>(rt, `/api/windows/${encodeURIComponent(id)}/test`, {
    method: 'POST',
  })
  if (status !== 200) {
    console.error(`${red('✘')} ${body.error === 'windows_host_not_found' ? `aucune VM « ${id} »` : (body.error ?? status)}`)
    return 1
  }
  const t = body.host.last_test!
  if (t.ok) {
    console.log(`${green('✔')} ${id} : ${t.detail}${t.latency_ms !== null ? dim(` (${t.latency_ms} ms)`) : ''}`)
    return 0
  }
  console.error(`${red('✘')} ${id} : ${t.detail}`)
  if (t.presented_fingerprint) {
    console.error(`  Compare avec ce qu'affiche la console de la VM ; si elle a été réinstallée, redéclare son empreinte :`)
    console.error(`    ${cmd(`windows add ${id} --fingerprint "SHA256:…"`)}`)
  } else if (/clé publique est-elle posée/.test(t.detail)) {
    showInstall(body.host)
  }
  return 1
}

async function key(config: HarnessConfig, id: string | undefined): Promise<number> {
  if (!id) {
    console.error('Usage : windows key <id>')
    return 1
  }
  const rt = await ensureDaemon(config, quiet)
  const { status, body } = await daemonJson<WindowsHostResponse>(rt, `/api/windows/${encodeURIComponent(id)}`)
  if (status !== 200) {
    console.error(`${red('✘')} aucune VM « ${id} »`)
    return 1
  }
  console.log(body.host.public_key)
  showInstall(body.host)
  return 0
}

async function remove(config: HarnessConfig, id: string | undefined): Promise<number> {
  if (!id) {
    console.error('Usage : windows remove <id>')
    return 1
  }
  const rt = await ensureDaemon(config, quiet)
  const { status, body } = await daemonJson<{ detached?: string[] }>(rt, `/api/windows/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
  if (status !== 200) {
    console.error(`${red('✘')} aucune VM « ${id} »`)
    return 1
  }
  console.log(`${green('✔')} VM « ${id} » retirée, sa clé effacée du coffre.`)
  if (body.detached?.length) console.log(`  Détachée des profils : ${body.detached.join(', ')}.`)
  console.log(`  ${dim('Sa clé publique reste posée sur la VM, inutile désormais : retire la ligne midgaard-' + id + ' de administrators_authorized_keys.')}`)
  return 0
}

/** Refus du daemon, tel que les routes des profils le rendent. */
interface Refused {
  error?: string
  reason?: string
  available?: string[]
}

/** Dit un refus du daemon en clair, avec ce qui aurait marché. */
function refused(status: number, body: Refused): number {
  if (body.error === 'agent_not_found') console.error(`${red('✘')} aucun profil de ce nom`)
  else if (body.error === 'windows_host_not_found') {
    console.error(`${red('✘')} VM inconnue ; déclarées : ${body.available?.length ? body.available.join(', ') : '(aucune)'}`)
  } else console.error(`${red('✘')} ${body.reason ?? body.error ?? status}`)
  return 1
}

/**
 * Attache une VM à un profil Developer, à partir de la tâche suivante. Une
 * VM au plus par profil : attacher en remplace une autre, et c'est dit.
 */
async function attach(config: HarnessConfig, hostId: string | undefined, agentId: string | undefined): Promise<number> {
  if (!hostId || !agentId) {
    console.error('Usage : windows attach <vm> <profil>')
    return 1
  }
  const rt = await ensureDaemon(config, quiet)
  const current = await daemonJson<{ agent?: Agent } & Refused>(rt, `/api/agents/${encodeURIComponent(agentId)}`)
  if (current.status !== 200 || !current.body.agent) return refused(current.status, current.body)
  const before = current.body.agent.windows_host
  if (before === hostId) {
    console.log(`${bold(agentId)} a déjà la VM ${bold(hostId)} : rien n'a changé.`)
    return 0
  }
  const { status, body } = await daemonJson<{ agent?: Agent } & Refused>(rt, `/api/agents/${encodeURIComponent(agentId)}/windows`, {
    method: 'PUT',
    body: JSON.stringify({ host: hostId }),
  })
  if (status !== 200 || !body.agent) return refused(status, body)
  console.log(`${green('✔')} VM ${bold(hostId)} attachée à ${bold(agentId)} ${dim('— à partir de la tâche suivante')}`)
  if (before) console.log(`  ${yellow(`Elle remplace ${before} : un profil n'a qu'une VM.`)}`)
  // Ne rien décrire qui n'existe pas encore : l'outil qui s'en sert vient en 5.3.
  console.log(dim('Aucun outil ne s\'en sert encore : les commandes sur la VM arrivent avec windows_run.'))
  return 0
}

/** Détache la VM d'un profil, à partir de la tâche suivante. */
async function detach(config: HarnessConfig, agentId: string | undefined): Promise<number> {
  if (!agentId) {
    console.error('Usage : windows detach <profil>')
    return 1
  }
  const rt = await ensureDaemon(config, quiet)
  const current = await daemonJson<{ agent?: Agent } & Refused>(rt, `/api/agents/${encodeURIComponent(agentId)}`)
  if (current.status !== 200 || !current.body.agent) return refused(current.status, current.body)
  const before = current.body.agent.windows_host
  if (!before) {
    console.log(`${bold(agentId)} n'a pas de VM : rien n'a changé.`)
    return 0
  }
  const { status, body } = await daemonJson<{ agent?: Agent } & Refused>(rt, `/api/agents/${encodeURIComponent(agentId)}/windows`, {
    method: 'PUT',
    body: JSON.stringify({ host: null }),
  })
  if (status !== 200 || !body.agent) return refused(status, body)
  console.log(`${green('✔')} VM ${bold(before)} détachée de ${bold(agentId)}`)
  return 0
}
