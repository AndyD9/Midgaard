/**
 * @file La VM Windows de test, déclarée par l'humain (Slice 9, étape 5.2).
 *
 * Trois décisions prises avec l'auteur (troisième tour, docs/SLICE9.md) :
 *
 *  - **la clé SSH est générée par Midgaard et dédiée à la VM**. La clé privée
 *    ne quitte jamais le daemon : générée par lui, rangée au coffre, lue au
 *    coffre à chaque connexion. La base ne garde que la clé **publique**, et la
 *    CLI donne la commande PowerShell exacte qui la pose sur la VM ;
 *  - **l'empreinte d'hôte est recopiée depuis la console de la VM**, jamais
 *    acceptée au premier contact : une déclaration sans empreinte est refusée ;
 *  - **chaque commande sur la VM sera approuvée** (sous-étape 5.3) : rien,
 *    dans la déclaration, ne la rend libre.
 *
 * Les commandes données à l'humain sont dans {@link windowsInstallCommands} et
 * {@link WINDOWS_FINGERPRINT_COMMAND} : une seule copie, que la CI exécutera
 * telle quelle sur un vrai Windows (sous-étape 5.5).
 */
import { z } from 'zod'

/**
 * Identifiant d'une VM : minuscules, chiffres, tiret, une lettre en tête — la
 * même forme qu'un serveur MCP, et pour la même raison : il nommera un outil.
 */
export const WINDOWS_HOST_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

/**
 * Nom d'hôte ou adresse : lettres, chiffres, point, tiret, deux-points
 * (IPv6). Ni schéma, ni chemin, ni espace : c'est une adresse, pas une URL.
 */
export const WINDOWS_ADDRESS_PATTERN = /^[A-Za-z0-9.:-]{1,253}$/

/**
 * Compte Windows : ce que Windows accepte dans un nom d'utilisateur, plus le
 * domaine (`DOMAINE\nom`, `nom@domaine`). Ni espace en tête, ni guillemet.
 */
export const WINDOWS_USERNAME_PATTERN = /^[A-Za-z0-9._@\\-][A-Za-z0-9 ._@\\-]{0,103}$/

/** Le dernier « Tester la connexion » d'une VM. */
export const windowsTestSchema = z.object({
  /** Vrai seulement si l'hôte épinglé a accepté la clé **et** que PowerShell a répondu. */
  ok: z.boolean(),
  /** Ce qui s'est passé, en clair. */
  detail: z.string(),
  at: z.iso.datetime(),
  latency_ms: z.number().int().min(0).nullable(),
  /** Version de PowerShell rapportée par la VM. */
  powershell: z.string().nullable(),
  /** Version de Windows rapportée par la VM. */
  os: z.string().nullable(),
  /** Empreinte présentée par l'hôte quand elle n'était pas celle épinglée. */
  presented_fingerprint: z.string().nullable(),
})
export type WindowsTest = z.infer<typeof windowsTestSchema>

/** Une VM déclarée, telle que la base la garde : jamais la clé privée. */
export const windowsHostSchema = z.object({
  id: z.string().regex(WINDOWS_HOST_ID_PATTERN),
  name: z.string(),
  host: z.string(),
  port: z.number().int().min(1).max(65535),
  username: z.string(),
  /** Empreinte épinglée, `SHA256:…`. */
  fingerprint: z.string(),
  /** Clé publique dédiée, `ssh-ed25519 AAAA… midgaard-<id>`, à poser sur la VM. */
  public_key: z.string(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  last_test: windowsTestSchema.nullable(),
})
export type WindowsHost = z.infer<typeof windowsHostSchema>

/** Une VM et ce qu'il faut faire sur elle : ce que rendent les routes. */
export const windowsHostViewSchema = windowsHostSchema.extend({
  /** Les lignes PowerShell qui posent la clé publique, à lancer en administrateur sur la VM. */
  install_commands: z.array(z.string()),
})
export type WindowsHostView = z.infer<typeof windowsHostViewSchema>

/**
 * Corps de `POST /api/windows`. L'empreinte est **exigée** à la déclaration
 * et facultative à la mise à jour (l'épinglée reste). `new_key` remplace la
 * clé : l'ancienne cesse aussitôt de servir, et la nouvelle est à poser.
 */
export const upsertWindowsHostRequestSchema = z.object({
  id: z.string().regex(WINDOWS_HOST_ID_PATTERN),
  name: z.string().min(1).max(64).optional(),
  host: z.string().regex(WINDOWS_ADDRESS_PATTERN),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().regex(WINDOWS_USERNAME_PATTERN),
  /** Telle que recopiée : la ligne de `ssh-keygen -lf`, ou `SHA256:…` seul. */
  fingerprint: z.string().max(512).optional(),
  new_key: z.boolean().default(false),
})
export type UpsertWindowsHostRequest = z.infer<typeof upsertWindowsHostRequestSchema>

/** Réponse de `GET /api/windows`. */
export const windowsHostsResponseSchema = z.object({ hosts: z.array(windowsHostViewSchema) })
export type WindowsHostsResponse = z.infer<typeof windowsHostsResponseSchema>

/** Réponse des routes qui portent sur une VM. */
export const windowsHostResponseSchema = z.object({ host: windowsHostViewSchema })
export type WindowsHostResponse = z.infer<typeof windowsHostResponseSchema>

/**
 * La commande à lancer **sur la console de la VM** pour lire l'empreinte de
 * sa clé d'hôte ed25519 : c'est elle que l'humain recopie.
 */
export const WINDOWS_FINGERPRINT_COMMAND = 'ssh-keygen.exe -lf "$env:ProgramData\\ssh\\ssh_host_ed25519_key.pub"'

/**
 * Les commandes qui activent le serveur OpenSSH de Windows, à lancer une fois
 * dans un PowerShell administrateur de la VM.
 */
export const WINDOWS_SSHD_COMMANDS: readonly string[] = [
  'Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0',
  'Set-Service -Name sshd -StartupType Automatic',
  'Start-Service sshd',
]

/**
 * Les lignes PowerShell qui posent une clé publique pour un compte
 * **administrateur** de la VM, à lancer dans un PowerShell administrateur.
 *
 * Pour un administrateur, le serveur OpenSSH de Windows ne lit pas
 * `~\.ssh\authorized_keys` mais `administrators_authorized_keys`, et refuse
 * le fichier si d'autres que les administrateurs et SYSTEM peuvent y écrire.
 * Les groupes sont désignés par leur SID (`S-1-5-32-544` Administrateurs,
 * `S-1-5-18` SYSTEM) : leur **nom** change avec la langue de Windows.
 *
 * @param publicKey la ligne `ssh-ed25519 AAAA… midgaard-<id>` : base64 et
 *                  commentaire sans apostrophe, donc sûre entre apostrophes
 */
export function windowsInstallCommands(publicKey: string): string[] {
  if (publicKey.includes("'")) throw new Error('clé publique inattendue : apostrophe')
  const file = '"$env:ProgramData\\ssh\\administrators_authorized_keys"'
  return [
    `Add-Content -Path ${file} -Value '${publicKey}'`,
    `icacls.exe ${file} /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F'`,
  ]
}
