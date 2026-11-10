/**
 * @file Faire passer un script PowerShell par une session SSH vers Windows
 * (Slice 9, étape 5).
 *
 * Win32-OpenSSH remet la commande reçue au shell par défaut de l'hôte —
 * `cmd.exe` sauf réglage contraire —, qui a ses propres règles de guillemets
 * et d'échappement. Un script passé en texte serait donc relu deux fois, par
 * `cmd` puis par PowerShell, et ce qui tourne ne serait plus exactement ce que
 * l'humain a approuvé. `-EncodedCommand` évite toute relecture : le script
 * voyage en base64 d'UTF-16LE, que PowerShell décode tel quel, et la ligne de
 * commande ne contient que des caractères que `cmd` laisse en paix.
 */

/** Le programme qui lit le script : Windows PowerShell 5.1, présent sur tout Windows pris en charge. */
export const POWERSHELL = 'powershell.exe'

/**
 * Ligne de commande qui fait exécuter `script` par PowerShell, sans profil,
 * sans invite (une question bloquerait jusqu'au délai), sans politique
 * d'exécution machine à modifier.
 *
 * @param script texte PowerShell exact, tel que l'humain l'a lu
 */
export function powershellCommand(script: string): string {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return `${POWERSHELL} -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`
}

/**
 * Relit le script d'une ligne produite par {@link powershellCommand} : pour
 * les tests, et pour un hôte factice qui doit savoir ce qu'on lui demande.
 *
 * @returns le script, ou `null` si la ligne n'en porte pas
 */
export function scriptOfPowershellCommand(command: string): string | null {
  const m = /-EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(command)
  return m ? Buffer.from(m[1]!, 'base64').toString('utf16le') : null
}
