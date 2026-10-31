#!/usr/bin/env node
/**
 * @file Point d'entrée de la CLI `harness`.
 *
 * Analyse d'arguments à la main : une douzaine de commandes, deux options. Une dépendance
 * de plus pour ça coûterait plus qu'elle ne rapporte.
 *
 * Seul endroit du paquet qui lit l'environnement ; tout le reste reçoit la
 * configuration en paramètre.
 */
import { readFileSync } from 'node:fs'
import { loadConfig } from '@midgaard/contracts'
import { decide, doctor, init, start, status, stop } from './commands.ts'
import { agents, pricing, providers } from './providers.ts'
import { exec, workspaces } from './workspaces.ts'
import { bold, dim } from './ui.ts'

const USAGE = `${bold('harness')} — harness local d'agents pour Claude Code

${bold('Commandes')}
  init [dossier]        Déclare le serveur MCP dans le .mcp.json du dossier (défaut : .)
  start                 Démarre le daemon s'il dort, et affiche où le joindre
  stop                  Arrête le daemon
  status [--limit N]    État du daemon et tâches récentes (lit la base même daemon arrêté)
  doctor                Diagnostic de l'installation
  approve [id]          Approuve une demande (la seule en attente si l'id est omis)
  reject [id] [motif]   Refuse une demande

${bold('Agents et fournisseurs')}
  agents                Profils d'exécution, et pourquoi certains sont désactivés
  providers             Fournisseurs de modèles déclarés
  providers add <id> --model <m> [--preset venice|openai|gemini|custom] [--base-url <u>]
                        Déclare un fournisseur ; la clé est saisie sans écho, jamais en argument
  providers test <id>   Joint l'endpoint et dit ce qu'il a vu
  providers remove <id> Retire un fournisseur et sa clé
  pricing               Tarifs en vigueur, et leur date de relevé
  pricing refresh <id>  Relève les tarifs chez le fournisseur (Venice les publie)

${bold('Worktrees et commandes des agents écrivants')}
  workspaces            Worktrees des tâches Developer, leur état sur le disque, les orphelins
  workspaces remove <branche|id> [--force]
                        Retire un worktree ; la branche reste. --force perd le travail non commité
  workspaces clean [--force]
                        Retire ceux des tâches finies ; les worktrees sales sont laissés sans --force
  exec                  Commandes lancées sans approbation dans les worktrees de ce dépôt
  exec allow [--yes] [--] <commande…>
                        Ajoute un argv exact à cette liste, après avertissement et confirmation
  exec revoke [--] <commande…>
                        Le retire : la commande attendra de nouveau un humain

${bold('Options')}
  -h, --help            Cette aide
  -v, --version         Version du harness

${dim('Environnement : MIDGAARD_HOME, MIDGAARD_PORT, MIDGAARD_IDLE_SHUTDOWN_S, MIDGAARD_DASHBOARD_DIR,')}
${dim('               MIDGAARD_VAULT, MIDGAARD_HTTP_POLICY, MIDGAARD_HTTP_ALLOW,')}
${dim('               MIDGAARD_EXEC_ALLOW')}`

/**
 * Version du paquet, pour `--version`, lue dans le `package.json` de la CLI —
 * une seule source. En dépôt, c'est `packages/cli/package.json` ; dans le paquet
 * publié, l'assemblage (`scripts/pack.ts`) y écrit la version publiée. Une
 * constante recopiée à la main aurait menti dès la première version.
 * `src/` et `dist/` sont au même niveau, d'où le même chemin relatif.
 */
const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

/**
 * Exécute la commande demandée.
 * @param argv arguments, sans `node` ni le chemin du script
 * @returns le code de sortie du processus
 */
export async function run(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  if (!command || command === '-h' || command === '--help' || command === 'help') {
    console.log(USAGE)
    return 0
  }
  if (command === '-v' || command === '--version') {
    console.log(VERSION)
    return 0
  }

  const config = loadConfig(process.env)

  switch (command) {
    case 'init':
      return init(rest[0] ?? process.cwd())
    case 'start':
      return start(config)
    case 'stop':
      return stop(config)
    case 'status': {
      const at = rest.indexOf('--limit')
      const limit = at >= 0 ? Number(rest[at + 1]) : 20
      return status(config, Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 20)
    }
    case 'doctor':
      return doctor(config, rest[0] ?? process.cwd())
    case 'approve':
      return decide(config, 'approve', rest[0], undefined)
    case 'reject':
      return decide(config, 'reject', rest[0], rest.slice(1).join(' ') || undefined)
    case 'agents':
      return agents(config)
    case 'providers':
      return providers(config, rest)
    case 'pricing':
      return pricing(config, rest)
    case 'workspaces':
      return workspaces(config, rest)
    case 'exec':
      return exec(config, rest)
    default:
      console.error(`Commande inconnue : ${command}\n`)
      console.error(USAGE)
      return 1
  }
}

process.exitCode = await run(process.argv.slice(2))
