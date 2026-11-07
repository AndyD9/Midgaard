/**
 * @file Clés et empreintes SSH de la VM Windows (Slice 9, étape 5).
 *
 * Deux décisions prises avec l'auteur (troisième tour) :
 *
 *  - **la clé est générée par Midgaard et dédiée à une VM** : ed25519, au
 *    format OpenSSH, rangée au coffre par l'appelant. Aucune clé de
 *    l'utilisateur n'est lue ni réemployée ;
 *  - **l'empreinte d'hôte est recopiée depuis la VM** par l'humain, lue sur
 *    sa console par `ssh-keygen -lf`. Midgaard ne fait jamais confiance au
 *    premier contact : une empreinte absente ou mal formée refuse la
 *    déclaration.
 *
 * L'empreinte se calcule comme OpenSSH : `SHA256:` puis le SHA-256 du blob
 * public, en base64 **sans** remplissage. Constaté identique à
 * `ssh-keygen -lf` avant d'écrire ce module.
 */
import { createHash } from 'node:crypto'
import ssh2 from 'ssh2'

/** Une paire de clés générée pour une VM. */
export interface GeneratedKeyPair {
  /** Clé privée, format OpenSSH (PEM). Ne quitte le processus que vers le coffre. */
  privateKey: string
  /** Ligne publique `ssh-ed25519 AAAA… commentaire`, à poser sur la VM. */
  publicKey: string
}

/**
 * Génère une paire ed25519 dédiée.
 *
 * @param comment commentaire de la clé publique (`midgaard-<vm>`) : c'est
 *                lui qui permet de la reconnaître, et de la retirer, dans le
 *                fichier des clés autorisées de la VM
 */
export function generateKeyPair(comment: string): GeneratedKeyPair {
  const pair = ssh2.utils.generateKeyPairSync('ed25519', { comment })
  return { privateKey: pair.private, publicKey: pair.public.trim() }
}

/** Empreinte OpenSSH d'un blob de clé publique (le format « wire » SSH). */
export function fingerprintOf(publicBlob: Buffer): string {
  return `SHA256:${createHash('sha256').update(publicBlob).digest('base64').replace(/=+$/, '')}`
}

/**
 * Empreinte d'une ligne de clé publique (`ssh-ed25519 AAAA… commentaire`).
 * @throws si la ligne n'est pas une clé publique lisible
 */
export function fingerprintOfPublicKey(line: string): string {
  const parsed = ssh2.utils.parseKey(line)
  if (parsed instanceof Error) throw parsed
  const key = Array.isArray(parsed) ? parsed[0]! : parsed
  return fingerprintOf(key.getPublicSSH())
}

/** Une empreinte SHA-256 OpenSSH : 43 caractères base64 sans remplissage. */
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/

/**
 * Lit une empreinte recopiée par l'humain : la forme nue (`SHA256:…`) ou la
 * ligne entière que rend `ssh-keygen -lf` (`256 SHA256:… commentaire
 * (ED25519)`). Une empreinte MD5 (`MD5:aa:bb:…`) est refusée : trop faible
 * pour épingler un hôte.
 *
 * @returns l'empreinte sous sa forme canonique, ou `null` si rien de valable
 */
export function normalizeFingerprint(input: string): string | null {
  const found = input.trim().split(/\s+/).find((w) => w.startsWith('SHA256:'))
  if (!found) return null
  const bare = found.replace(/=+$/, '')
  return FINGERPRINT.test(bare) ? bare : null
}
