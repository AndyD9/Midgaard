/**
 * @file Les quatre coffres : trousseau macOS, DPAPI Windows, libsecret Linux,
 * et repli fichier.
 *
 * Aucun n'ajoute de dépendance native. C'est la même règle qui a fait choisir
 * `node:sqlite` plutôt que `better-sqlite3` en Slice 1 : un `git clone` doit
 * suffire partout, sans binaire précompilé à télécharger ni compilateur à
 * trouver. On parle donc aux utilitaires que le système fournit déjà.
 *
 * Le service est nommé `midgaard` dans les trois magasins système : les secrets
 * du harness se repèrent et se révoquent ensemble, sans fouiller.
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { run } from './exec.ts'
import { normalizeRef, VaultError, type SecretVault } from './types.ts'

/** Nom de service commun aux magasins système. */
const SERVICE = 'midgaard'

/**
 * Préfixe des valeurs écrites dans le trousseau macOS, suivi du secret en base64.
 *
 * **Pourquoi encoder.** `security find-generic-password -w` rend le mot de passe
 * **en hexadécimal** — sans préfixe, sans signalement — dès qu'il contient un
 * octet non imprimable en ASCII. Un aller-retour naïf rend donc
 * `736b2d…` au lieu de la clé, et corrompt silencieusement tout secret
 * non anglais. Mesuré, pas supposé.
 *
 * Deviner à la relecture ne marche pas : `abcdef` est un mot de passe valide
 * **et** de l'hexadécimal valide, et rien ne permet de trancher. On supprime
 * donc l'ambiguïté à l'écriture en ne déposant que de l'ASCII imprimable.
 *
 * Une valeur sans ce préfixe est rendue telle quelle : c'est le cas d'une clé
 * qu'un utilisateur aurait déposée lui-même avec `security`, et la casser serait
 * pire que de la rendre.
 */
const MACOS_ENCODING_PREFIX = 'mg1:'

/**
 * Trousseau macOS, via l'utilitaire `security`.
 *
 * ⚠️ `security add-generic-password` n'accepte le mot de passe qu'en argument
 * (`-w`), donc il est visible dans `ps` pour les processus du **même**
 * utilisateur, le temps de l'appel. C'est une limite de l'outil, pas un choix :
 * `security` ne lit pas les mots de passe sur son entrée standard. Le modèle de
 * menace du harness place déjà « un autre processus du même utilisateur » hors
 * périmètre — ce processus peut de toute façon lire le jeton du daemon. La
 * lecture (`find-generic-password`), elle, n'expose rien.
 */
export const macosKeychain: SecretVault = {
  id: 'macos-keychain',
  label: 'trousseau macOS',
  osBacked: true,

  async available() {
    if (process.platform !== 'darwin') return false
    try {
      await run('security', ['help'])
      return true
    } catch {
      return false
    }
  },

  async get(ref) {
    const account = normalizeRef(ref)
    const out = await run('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'])
    // 44 : l'élément n'existe pas. C'est une réponse, pas une panne.
    if (out.code === 44) return null
    if (out.code !== 0) throw new VaultError('macos-keychain', out.stderr.trim() || `code ${out.code}`)
    // `security` ajoute un saut de ligne final qui ne fait pas partie du secret.
    const raw = out.stdout.replace(/\n$/, '')
    if (!raw.startsWith(MACOS_ENCODING_PREFIX)) return raw
    return Buffer.from(raw.slice(MACOS_ENCODING_PREFIX.length), 'base64').toString('utf8')
  },

  async set(ref, value) {
    const account = normalizeRef(ref)
    // `-U` remplace l'élément existant : sans lui, `security` refuse en doublon.
    const out = await run('security', [
      'add-generic-password', '-U',
      '-s', SERVICE,
      '-a', account,
      '-D', 'Midgaard API key',
      '-j', 'Clé de fournisseur de modèle, déposée par Midgaard',
      // Base64 : voir MACOS_ENCODING_PREFIX. Ce qui est déposé est toujours
      // de l'ASCII imprimable, donc `security` le rend verbatim à la relecture.
      '-w', MACOS_ENCODING_PREFIX + Buffer.from(value, 'utf8').toString('base64'),
    ])
    if (out.code !== 0) throw new VaultError('macos-keychain', out.stderr.trim() || `code ${out.code}`)
  },

  async delete(ref) {
    const account = normalizeRef(ref)
    const out = await run('security', ['delete-generic-password', '-s', SERVICE, '-a', account])
    if (out.code !== 0 && out.code !== 44) {
      throw new VaultError('macos-keychain', out.stderr.trim() || `code ${out.code}`)
    }
  },
}

/**
 * Windows, via DPAPI et PowerShell.
 *
 * `ConvertFrom-SecureString` sans clé explicite chiffre avec DPAPI, lié au
 * **compte utilisateur et à la machine** : le fichier produit est inutilisable
 * ailleurs et par quelqu'un d'autre. Le chiffré est rangé sous `%LOCALAPPDATA%`.
 *
 * **Pourquoi pas le Credential Manager** : `cmdkey`, le seul utilitaire fourni
 * d'office, sait écrire un identifiant mais **pas relire un mot de passe** —
 * c'est délibéré de la part de Windows. Le module PowerShell `CredentialManager`
 * le permettrait, mais il n'est pas installé par défaut : ce serait exactement la
 * dépendance qu'on refuse.
 *
 * Deux précautions dans la façon d'appeler PowerShell :
 *  - le **secret passe par stdin**, jamais par la ligne de commande ;
 *  - la **référence passe par une variable d'environnement**, jamais interpolée
 *    dans le script : aucune chaîne venue d'ailleurs n'est concaténée à du code.
 */
export const windowsDpapi: SecretVault = {
  id: 'windows-dpapi',
  label: 'DPAPI Windows (compte utilisateur)',
  osBacked: true,

  async available() {
    if (process.platform !== 'win32') return false
    try {
      const out = await powershell('[Console]::Out.Write("ok")', 'probe')
      return out.code === 0 && out.stdout.includes('ok')
    } catch {
      return false
    }
  },

  async get(ref) {
    const out = await powershell(
      `${PS_PREAMBLE}
       if (-not (Test-Path -LiteralPath $p)) { exit 44 }
       $sec = Get-Content -Raw -LiteralPath $p | ConvertTo-SecureString
       $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
       try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)) }
       finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }`,
      ref,
    )
    if (out.code === 44) return null
    if (out.code !== 0) throw new VaultError('windows-dpapi', out.stderr.trim() || `code ${out.code}`)
    return out.stdout
  },

  async set(ref, value) {
    const out = await powershell(
      `${PS_PREAMBLE}
       New-Item -ItemType Directory -Force -Path $dir | Out-Null
       $plain = [Console]::In.ReadToEnd()
       ConvertTo-SecureString -String $plain -AsPlainText -Force |
         ConvertFrom-SecureString |
         Set-Content -LiteralPath $p -NoNewline -Encoding ascii`,
      ref,
      value,
    )
    if (out.code !== 0) throw new VaultError('windows-dpapi', out.stderr.trim() || `code ${out.code}`)
  },

  async delete(ref) {
    const out = await powershell(
      `${PS_PREAMBLE}
       Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue`,
      ref,
    )
    if (out.code !== 0) throw new VaultError('windows-dpapi', out.stderr.trim() || `code ${out.code}`)
  },
}

/**
 * Préambule commun des scripts PowerShell : arrête au premier incident et
 * calcule le chemin du secret **depuis l'environnement**, jamais depuis une
 * chaîne interpolée.
 */
const PS_PREAMBLE = `
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:LOCALAPPDATA 'Midgaard\\secrets'
$p = Join-Path $dir ($env:MIDGAARD_SECRET_REF + '.dpapi')
`.trim()

/**
 * Lance un script PowerShell.
 *
 * Le script est transmis en `-EncodedCommand` (base64 d'UTF-16LE), ce qui évite
 * toute question de guillemets entre `cmd`, Node et PowerShell. `powershell.exe`
 * plutôt que `pwsh` : la version 5.1 est présente sur toute installation
 * Windows, PowerShell 7 non.
 */
async function powershell(script: string, ref: string, stdin?: string) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  // La référence voyage par l'environnement **du seul processus fils**, passée
  // en argument à `run`.
  //
  // Elle transitait auparavant par `process.env`, ce qui ne marchait pas :
  // `run` reconstruit l'environnement du fils à partir d'une liste blanche où
  // cette variable ne figurait pas. Le script lisait donc `$null`, et
  // `Join-Path $dir ($null + '.dpapi')` désignait **le même fichier pour
  // toutes les références** — chaque clé déposée écrasait la précédente, et
  // toute relecture rendait la dernière écrite, sans la moindre erreur.
  // Mesuré en reproduisant la transmission, pas déduit (dette n° 3 de la
  // Slice 2 : DPAPI était écrit, pas constaté).
  //
  // Au passage, écrire dans `process.env` rendait aussi deux `set` concurrents
  // capables de se voler leur référence. Un argument n'a pas ce défaut.
  return await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    stdin,
    { MIDGAARD_SECRET_REF: normalizeRef(ref) },
  )
}

/**
 * Linux de bureau, via `secret-tool` (libsecret) et donc le trousseau de la
 * session — GNOME Keyring, KWallet selon l'environnement.
 *
 * `secret-tool store` lit le secret sur son entrée standard : rien n'apparaît
 * dans `ps`. Absent d'un serveur sans session graphique, d'où le repli.
 */
export const libsecret: SecretVault = {
  id: 'libsecret',
  label: 'trousseau de session (libsecret)',
  osBacked: true,

  async available() {
    if (process.platform === 'darwin' || process.platform === 'win32') return false
    try {
      // `lookup` sur une référence inexistante sort en 1 sans rien écrire : cela
      // prouve que le binaire **et** le service répondent, sans rien déposer.
      const out = await run('secret-tool', ['lookup', 'service', SERVICE, 'account', '__probe__'])
      if (out.code === 0) return true
      // Un code 1 ne suffit pas : `secret-tool` sort **aussi** en 1 quand il ne
      // joint pas le bus de session — serveur sans session graphique, trousseau
      // verrouillé. Accepter ce cas faisait élire libsecret sur une machine où
      // il ne peut rien ranger : `available()` disait oui, et chaque `set`
      // levait ensuite. Ce qui distingue les deux est la sortie d'erreur : une
      // absence est muette, une panne parle.
      return out.code === 1 && out.stderr.trim() === ''
    } catch {
      return false
    }
  },

  async get(ref) {
    const account = normalizeRef(ref)
    const out = await run('secret-tool', ['lookup', 'service', SERVICE, 'account', account])
    if (out.code !== 0) return null
    return out.stdout
  },

  async set(ref, value) {
    const account = normalizeRef(ref)
    const out = await run(
      'secret-tool',
      ['store', '--label=Midgaard API key', 'service', SERVICE, 'account', account],
      value,
    )
    if (out.code !== 0) throw new VaultError('libsecret', out.stderr.trim() || `code ${out.code}`)
  },

  async delete(ref) {
    const account = normalizeRef(ref)
    const out = await run('secret-tool', ['clear', 'service', SERVICE, 'account', account])
    if (out.code !== 0) throw new VaultError('libsecret', out.stderr.trim() || `code ${out.code}`)
  },
}

/**
 * Repli : un fichier `0600` dans un dossier `0700`, sous le dossier runtime.
 *
 * **Ce n'est pas un coffre système**, et `osBacked` vaut faux pour que
 * l'interface le dise. Le secret est en clair sur le disque : une sauvegarde de
 * `~/.midgaard` emporte les clés avec elle. Il existe parce qu'un serveur Linux
 * sans session graphique n'a pas de trousseau, et qu'un harness qui refuserait
 * de démarrer là serait moins utile qu'un harness qui démarre en le disant.
 *
 * @param dir dossier des secrets, dérivé de `config.home`
 */
export function fileVault(dir: string): SecretVault {
  return {
    id: 'file',
    label: `fichier ${dir} (pas de protection système)`,
    osBacked: false,

    async available() {
      return true
    },

    async get(ref) {
      try {
        return readFileSync(join(dir, normalizeRef(ref)), 'utf8')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw new VaultError('file', (e as Error).message)
      }
    },

    async set(ref, value) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const path = join(dir, normalizeRef(ref))
      writeFileSync(path, value, { mode: 0o600 })
      // `writeFileSync` n'applique `mode` qu'à la **création** : un fichier
      // préexistant aux mauvaises permissions les garderait sans ce `chmod`.
      chmodSync(path, 0o600)
    },

    async delete(ref) {
      rmSync(join(dir, normalizeRef(ref)), { force: true })
    },
  }
}
