/**
 * @file Les playbooks (Slice 9, étape 1) : lister le dossier, attacher des
 * playbooks à un profil, les lire au départ d'une tâche et les ajouter à sa
 * consigne.
 *
 * Un playbook est du savoir métier écrit par un humain (Sigma, YARA, Python,
 * analyse statique de PE…), versionné dans le clone Midgaard, `playbooks/`
 * (docs/SLICE9.md, décisions 1 à 5). Ce qui en découle ici :
 *
 *  - **l'humain attache, jamais un agent.** Aucun outil d'agent n'écrit
 *    dans ce dossier ni ne choisit ce qui est attaché : la route
 *    `PUT /api/agents/:id/playbooks` est la seule porte ;
 *  - **lu au départ de chaque tâche**, pas à l'attache : corriger un
 *    playbook vaut pour la tâche suivante sans rien réattacher. En
 *    contrepartie, ce qui a été lu est **journalisé avec son SHA-256** — une
 *    tâche dit quel savoir elle a reçu, même si le fichier change ensuite ;
 *  - **tout ou rien** : un playbook attaché mais absent ou invalide au départ
 *    arrête la tâche avant tout appel de modèle, comme un serveur MCP qui ne
 *    démarre pas. Un agent privé en silence d'une partie de son savoir
 *    travaillerait moins bien sans que personne sache pourquoi ;
 *  - **après les règles du profil**, sous un titre qui dit qu'il ne les
 *    remplace pas, et **avant** le rôle d'un agent créé (décision 3).
 *
 * Le dossier est celui du clone, que l'humain contrôle : il n'est pas écrit
 * par un agent, contrairement à un worktree. Les vérifications de chemin y
 * sont donc plus simples qu'ailleurs — l'identifiant ne peut désigner aucun
 * fichier hors du dossier ({@link PLAYBOOK_ID_PATTERN}), et un lien
 * symbolique est refusé pour qu'un playbook soit toujours un fichier du
 * dossier, relu au commit comme les autres.
 */
import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PLAYBOOK_ID_PATTERN,
  PLAYBOOK_MAX_BYTES,
  PLAYBOOKS_MAX_BYTES_PER_AGENT,
  type Agent,
  type HarnessConfig,
  type PlaybookSummary,
} from '@midgaard/contracts'
import type { HarnessStore } from '@midgaard/persistence'
import { CREATED_ROLE_HEADING } from './agents.ts'
import type { Refusal } from './task-manager.ts'

/**
 * Emplacement par défaut des playbooks : `playbooks/` à la racine du clone,
 * à trois niveaux de ce fichier — depuis `src/` comme depuis `dist/`, à la
 * même profondeur (même calcul que le dashboard, `daemon.ts`).
 */
export function defaultPlaybooksDir(): string {
  return fileURLToPath(new URL('../../../playbooks/', import.meta.url))
}

/** Le dossier des playbooks d'une configuration : le sien, ou celui du clone. */
export function playbooksDirOf(config: Pick<HarnessConfig, 'playbooksDir'>): string {
  return config.playbooksDir ?? defaultPlaybooksDir()
}

/**
 * Titre de la section des playbooks dans la consigne. En anglais : c'est le
 * modèle qui la lit, et elle ne nomme ni modèle ni client (neutralité, Slice 5).
 * Elle dit d'abord la préséance, pour la même raison que le rôle d'un agent
 * créé : un playbook qui contredirait une règle de sécurité ne doit jamais
 * l'emporter.
 */
export const PLAYBOOKS_HEADING =
  '## Playbooks\n\nThe human who configured this profile attached the reference notes below. They add to the ' +
  'rules above and never replace them; where they conflict, the rules above win. Apply what fits your task.'

/** Un playbook lu, prêt à entrer dans une consigne. */
export interface LoadedPlaybook {
  id: string
  title: string
  bytes: number
  sha256: string
  text: string
}

/**
 * Lit un playbook et dit s'il est utilisable. Ne lève pas sur un fichier
 * invalide : l'humain doit le voir listé avec son motif.
 *
 * @returns `null` si ce n'est pas un fichier ordinaire (absent, dossier, lien)
 */
async function readPlaybook(dir: string, id: string): Promise<(LoadedPlaybook & { unusable_reason: string | null }) | null> {
  const path = join(dir, `${id}.md`)
  let st
  try {
    st = await lstat(path)
  } catch {
    return null
  }
  if (!st.isFile()) return null
  const bytes = await readFile(path)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  let text = ''
  let unusable: string | null = null
  if (bytes.length > PLAYBOOK_MAX_BYTES) {
    unusable = `trop gros : ${bytes.length} octets, au plus ${PLAYBOOK_MAX_BYTES}`
  } else {
    try {
      // `fatal` : un octet invalide est une erreur, pas un caractère de
      // remplacement glissé en silence dans la consigne.
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      unusable = 'pas de l\'UTF-8 valide'
    }
  }
  const title = /^#\s+(.+?)\s*$/m.exec(text)?.[1] ?? id
  return { id, title, bytes: bytes.length, sha256, text, unusable_reason: unusable }
}

/**
 * Les playbooks du dossier, triés par identifiant. Un dossier absent rend une
 * liste vide : un clone sans playbooks est un clone valide.
 */
export async function listPlaybooks(dir: string): Promise<PlaybookSummary[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const ids = names
    .filter((n) => n.endsWith('.md'))
    .map((n) => n.slice(0, -3))
    .filter((id) => PLAYBOOK_ID_PATTERN.test(id))
    .sort()
  const out: PlaybookSummary[] = []
  for (const id of ids) {
    const p = await readPlaybook(dir, id)
    if (p) out.push({ id: p.id, title: p.title, bytes: p.bytes, sha256: p.sha256, unusable_reason: p.unusable_reason })
  }
  return out
}

/**
 * Lit les playbooks d'une tâche, dans l'ordre demandé. Tout ou rien.
 *
 * @returns les playbooks lus, ou la phrase qui dit pourquoi la tâche ne peut
 *          pas partir — à rendre telle quelle dans l'erreur de la tâche
 */
export async function loadPlaybooks(
  dir: string,
  ids: readonly string[],
): Promise<{ playbooks: LoadedPlaybook[] } | { error: string }> {
  const playbooks: LoadedPlaybook[] = []
  let total = 0
  for (const id of ids) {
    if (!PLAYBOOK_ID_PATTERN.test(id)) return { error: `playbook « ${id} » : identifiant invalide` }
    const p = await readPlaybook(dir, id)
    if (!p) return { error: `playbook « ${id} » introuvable dans ${dir}` }
    if (p.unusable_reason) return { error: `playbook « ${id} » inutilisable : ${p.unusable_reason}` }
    total += p.bytes
    playbooks.push({ id: p.id, title: p.title, bytes: p.bytes, sha256: p.sha256, text: p.text })
  }
  // Rebornés ici et pas seulement à l'attache : un fichier peut grossir entre
  // l'attache et la tâche, et c'est la tâche qui paie chaque octet.
  if (total > PLAYBOOKS_MAX_BYTES_PER_AGENT) {
    return { error: `playbooks trop gros ensemble : ${total} octets, au plus ${PLAYBOOKS_MAX_BYTES_PER_AGENT}` }
  }
  return { playbooks }
}

/**
 * Ajoute des playbooks à une consigne : après les règles du profil, avant le
 * rôle d'un agent créé s'il y en a un.
 *
 * Le rôle se repère par {@link CREATED_ROLE_HEADING}, que seul le daemon
 * écrit (`resolveCreatedAgent`) : sa **première** occurrence est donc la
 * nôtre — un rôle écrit par l'orchestrateur qui recopierait ce titre vient
 * après lui.
 *
 * @returns la consigne inchangée s'il n'y a aucun playbook
 */
export function composeSystemPrompt(systemPrompt: string, playbooks: readonly LoadedPlaybook[]): string {
  if (playbooks.length === 0) return systemPrompt
  const section = [
    PLAYBOOKS_HEADING,
    ...playbooks.map((p) => `### Playbook: ${p.id}\n\n${p.text.trim()}`),
  ].join('\n\n')
  const role = systemPrompt.indexOf(`\n\n${CREATED_ROLE_HEADING}`)
  if (role === -1) return `${systemPrompt}\n\n${section}`
  return `${systemPrompt.slice(0, role)}\n\n${section}${systemPrompt.slice(role)}`
}

/**
 * Règle les playbooks d'un profil (`PUT /api/agents/:id/playbooks`).
 *
 * Les règles, chacune pour une raison :
 *
 *  - **le profil simulé n'en a pas** : il n'appelle aucun modèle, personne ne
 *    lirait la consigne ;
 *  - **chaque playbook doit exister et être utilisable maintenant** : un nom
 *    inconnu ferait échouer la tâche suivante loin de sa cause ;
 *  - **la somme tient dans {@link PLAYBOOKS_MAX_BYTES_PER_AGENT}** : elle est
 *    relue, donc payée, à chaque appel de modèle.
 *
 * Un doublon est retiré, l'ordre est gardé : c'est celui de la consigne.
 * Vaut pour les tâches à venir ; une tâche en cours garde ce qu'elle a lu.
 *
 * @param playbooks la liste **complète** ; vide, le profil n'en a plus
 * @returns le profil après coup, ou un refus à rendre tel quel au client
 */
export async function setAgentPlaybooks(
  store: HarnessStore,
  dir: string,
  id: string,
  playbooks: readonly string[],
  log: (...a: unknown[]) => void = () => {},
): Promise<Agent | Refusal> {
  const agent = store.getAgent(id)
  if (!agent) return { error: 'agent_not_found', status: 404, detail: { agent_id: id } }
  if (agent.kind === 'simulated') {
    return {
      error: 'agent_has_no_model',
      status: 409,
      detail: { agent_id: id, reason: 'le profil simulé n\'appelle aucun modèle : il ne lit aucune consigne' },
    }
  }
  const wanted = [...new Set(playbooks)]
  const available = await listPlaybooks(dir)
  const byId = new Map(available.map((p) => [p.id, p]))
  const unknown = wanted.filter((p) => !byId.has(p))
  if (unknown.length > 0) {
    return {
      error: 'playbook_not_found',
      status: 404,
      detail: { playbooks: unknown, available: available.map((p) => p.id), dir },
    }
  }
  const unusable = wanted.filter((p) => byId.get(p)!.unusable_reason !== null)
  if (unusable.length > 0) {
    return {
      error: 'playbook_unusable',
      status: 409,
      detail: { playbooks: unusable.map((p) => ({ id: p, reason: byId.get(p)!.unusable_reason })) },
    }
  }
  const total = wanted.reduce((n, p) => n + byId.get(p)!.bytes, 0)
  if (total > PLAYBOOKS_MAX_BYTES_PER_AGENT) {
    return {
      error: 'playbooks_too_large',
      status: 409,
      detail: { bytes: total, max_bytes: PLAYBOOKS_MAX_BYTES_PER_AGENT },
    }
  }
  const updated = store.setAgentPlaybooks(id, wanted)!
  log(`profil « ${id} » : playbooks ${wanted.length ? wanted.join(', ') : '(aucun)'} — vaut pour les tâches à venir`)
  return updated
}
