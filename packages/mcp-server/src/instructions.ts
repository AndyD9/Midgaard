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

/**
 * Commande d'approbation à donner à l'utilisateur, adaptée au mode d'exécution.
 *
 * Installé depuis npm, le binaire `harness` est dans le `PATH`. Lancé depuis les
 * sources du dépôt, il ne l'est pas : la commande passe alors par npm, avec le
 * chemin absolu du dépôt.
 */
export function approvalCommand(approvalId: string): string {
  // On se repère sur ce fichier-ci plutôt que sur le paquet `cli` : celui-ci
  // dépend du serveur MCP (il déclare son point d'entrée dans `.mcp.json`), et
  // l'inverse créerait un cycle entre les deux paquets.
  const self = fileURLToPath(import.meta.url)
  if (!self.endsWith('.ts')) return `harness approve ${approvalId}`
  // packages/mcp-server/src/instructions.ts → racine du dépôt
  const repoRoot = resolve(dirname(self), '..', '..', '..')
  return `cd ${JSON.stringify(repoRoot)} && npm run harness -- approve ${approvalId}`
}

/**
 * Consigne complète à transmettre telle quelle à l'utilisateur.
 *
 * @param approvalId   identifiant de la demande, jamais celui de la tâche : une
 *                     décision porte sur une opération précise
 * @param operation    ce que l'humain autorise, en clair
 * @param dashboardUrl URL du dashboard, ou `null` s'il n'est pas servi
 */
export function approvalInstructions(
  approvalId: string,
  operation: string,
  dashboardUrl: string | null,
): string {
  const command = approvalCommand(approvalId)
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
