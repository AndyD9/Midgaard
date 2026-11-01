/**
 * @file Consignes destinées à l'humain pour approuver une tâche.
 *
 * **Règle absolue : ne jamais décrire ce qui n'existe pas.** Au premier essai
 * réel de la Slice 0, les consignes du serveur affirmaient que les approbations
 * se faisaient « dans le dashboard Midgaard ». Claude l'a répété tel quel à
 * l'utilisateur, alors qu'aucun dashboard n'existait : la tâche s'est terminée
 * sans que personne ne récupère son résultat.
 *
 * D'où la construction ci-dessous : la consigne est calculée à partir de
 * l'état **vérifié** du daemon (`dashboard_available`), et la commande de repli
 * est complète, chemin compris, prête à copier — sans `<placeholder>`, que zsh
 * interpréterait comme une redirection.
 */
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { harnessCommand } from '@midgaard/contracts'

/**
 * Commande d'approbation à donner à l'utilisateur.
 *
 * Midgaard ne s'installe que depuis un clone : aucun binaire `harness` n'est
 * dans le `PATH`, la commande passe par npm, avec le chemin absolu du dépôt —
 * l'utilisateur la lance depuis le dossier où il travaille, pas depuis le clone.
 * Elle porte aussi le dossier runtime quand il n'est pas celui par défaut :
 * sans lui, elle cherchait la demande dans `~/.midgaard`, sur le daemon d'une
 * autre installation (Slice 4, étape 8).
 *
 * @param approvalId identifiant de la demande
 * @param home       dossier runtime si désigné (`config.homeIsExplicit`), sinon `null`
 */
export function approvalCommand(approvalId: string, home: string | null = null): string {
  // On se repère sur ce fichier-ci plutôt que sur le paquet `cli` : celui-ci
  // dépend du serveur MCP (il déclare son point d'entrée dans `.mcp.json`), et
  // l'inverse créerait un cycle entre les deux paquets.
  const self = fileURLToPath(import.meta.url)
  // packages/mcp-server/{src,dist}/instructions.* → racine du dépôt : même
  // profondeur depuis les sources et depuis le build.
  const repoRoot = resolve(dirname(self), '..', '..', '..')
  return harnessCommand(`approve ${approvalId}`, { repoRoot, home })
}

/**
 * Consigne complète à transmettre telle quelle à l'utilisateur.
 *
 * @param approvalId   identifiant de la demande, jamais celui de la tâche : une
 *                     décision porte sur une opération précise
 * @param operation    ce que l'humain autorise, en clair
 * @param dashboardUrl URL du dashboard, ou `null` s'il n'est pas servi
 * @param home         dossier runtime si désigné, sinon `null` ; voir {@link approvalCommand}
 */
export function approvalInstructions(
  approvalId: string,
  operation: string,
  dashboardUrl: string | null,
  home: string | null = null,
): string {
  const command = approvalCommand(approvalId, home)
  if (dashboardUrl) {
    return (
      `A human must approve: ${operation}. ` +
      `Open the Midgaard dashboard at ${dashboardUrl} and approve it there, ` +
      `or run this command in a terminal: ${command}`
    )
  }
  return (
    `A human must approve: ${operation}. ` +
    `The dashboard is not built, so approval happens in a terminal. ` +
    `Run this command exactly as written: ${command}`
  )
}
