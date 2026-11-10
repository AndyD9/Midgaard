# `@midgaard/remote`

La connexion SSH à la **VM Windows de test** (Slice 9, étape 5) : une clé
générée par Midgaard et dédiée à la VM, une empreinte d'hôte recopiée par
l'humain depuis la console de la VM, des commandes et une copie de fichiers.

Le paquet ne connaît ni le daemon, ni la base, ni les approbations, ni
PowerShell : il transporte des commandes et des fichiers vers un hôte
épinglé. L'outil qui en fait usage, et l'approbation de chaque commande,
viennent ensuite (sous-étapes 5.2 et 5.3, [docs/SLICE9.md](../../docs/SLICE9.md)).

```ts
const pair = generateKeyPair('midgaard-vm1')          // ed25519, OpenSSH ; la privée va au coffre
const pinned = normalizeFingerprint(lineFromVmConsole) // « 256 SHA256:… (ED25519) » → « SHA256:… »
const session = await RemoteSession.open({ host, port: 22, username, privateKey, fingerprint: pinned! })
const r = await session.run('powershell.exe -NoProfile -Command "$PSVersionTable"', { timeoutMs: 60_000, signal })
await session.uploadTree(worktree, '/C:/midgaard/tache', (rel) => (rel === '.git' ? 'never copied' : null))
session.close()                                        // idempotente, ne lève pas
```

## Ce que la session garantit

| Garantie | Comment |
|---|---|
| Empreinte comparée **avant** toute authentification | `hostVerifier`, appelé pendant l'échange de clés : un hôte qui présente une autre clé ne reçoit ni signature ni nom d'utilisateur. Le refus (`fingerprint_mismatch`) dit l'empreinte vue. Les tests comptent zéro tentative d'authentification côté hôte |
| La clé ne quitte pas la mémoire | Lue au coffre par l'appelant, passée telle quelle à `ssh2` ; ni agent SSH, ni mot de passe, ni clavier |
| Une commande a un délai et s'annule | Au délai ou au signal, le canal est fermé et le résultat le dit (`timedOut`, `cancelled`). Le sort des processus de l'hôte : sous-étape 5.4 |
| Sortie bornée | Début (8 Kio) et fin (32 Kio) gardés, le reste compté ; chaque morceau rendu à `onOutput` |
| La copie ne suit jamais un lien | `lstat` : un lien (vers `~/.ssh`, par exemple) est écarté et nommé. Au-delà de 20 000 fichiers ou 256 Mio, refus **avant** toute copie |

## Le dossier d'une tâche (étape 5.3b)

```ts
const where = remoteTaskDir(await session.homeDir(), task.id)  // chemins seulement, aucun appel
await session.replaceTree(worktree, where.work, where.base, exclude) // efface work, puis recopie
await session.removeTree(where.dir, where.base)                // fin de tâche
```

| Chemin | Rôle |
|---|---|
| `<home>/midgaard` (`base`) | Racine permise : **rien n'est jamais effacé hors d'elle** |
| `<home>/midgaard/tasks/<tâche>` (`dir`) | Dossier de la tâche, effacé à sa fin |
| `<home>/midgaard/tasks/<tâche>/work` (`work`) | Copie du worktree, refaite en entier avant chaque commande |

`<home>` est ce que le SFTP rend pour `.` (`/C:/Users/<compte>` sous
Windows) : aucune supposition sur `C:\`. L'identifiant de tâche doit être un
UUID — ni `..`, ni séparateur, ni lettre de lecteur.

`removeTree` vérifie trois choses **avant** le premier effacement :

1. le dossier visé est **strictement** sous la racine permise (la racine
   elle-même, un voisin au même préfixe ou un `..` sont refusés sans rien
   envoyer ; la casse est ignorée, comme sous Windows) ;
2. la racine et chaque dossier intermédiaire sont de vrais dossiers, pas des
   liens : un lien posé là désignerait un autre endroit du disque ;
3. chaque entrée est lue par `lstat` : un lien est retiré **lui-même**, nommé
   dans le bilan, jamais parcouru.

Au-delà de 100 000 entrées, l'effacement s'arrête et le dit.

**Reste à constater sur un vrai Windows (5.5)** : ce que le SFTP de
Win32-OpenSSH dit d'une **jonction** NTFS — lien, ou dossier ? Tant que ce
n'est pas fait, le point 3 n'est prouvé que contre des liens symboliques
POSIX, par l'hôte factice.

## PowerShell

`powershellCommand(script)` rend `powershell.exe -NoProfile -NonInteractive
-ExecutionPolicy Bypass -EncodedCommand <base64 UTF-16LE>`. Win32-OpenSSH
remet la commande au shell de l'hôte (`cmd.exe` par défaut), qui a ses
propres règles de guillemets : encodé, le script n'est relu par personne
avant PowerShell, et ce qui tourne est exactement ce qui a été montré.
`scriptOfPowershellCommand` fait le chemin inverse (tests, hôte factice).

## Les refus

`RemoteError.kind` : `fingerprint_mismatch`, `auth_failed` (la clé
publique n'est pas posée sur la VM), `unreachable`, `timeout`, `protocol`.
Les messages sont en anglais : ils peuvent remonter à un modèle.

## L'empreinte

Comme OpenSSH : `SHA256:` puis le SHA-256 du blob public en base64 sans
remplissage — constaté identique à `ssh-keygen -lf`. `normalizeFingerprint`
accepte la ligne entière de `ssh-keygen -lf` ou la forme nue, et refuse
une empreinte MD5.

## Une paire sur 256 mal formée

`ssh2` 1.17 rend **une paire ed25519 sur 256 inutilisable** : quand le
premier octet de la clé vaut zéro, il le retire comme pour un grand entier,
et la clé annonce 31 octets au lieu de 32 (`AAAAH…` au lieu de `AAAAI…`) ;
ni la publique ni la privée ne se relisent. `generateKeyPair` relit donc
chaque paire, compare la publique à celle que donne la privée, vérifie une
signature (`isUsableKeyPair`), et tire de nouveau sinon. Trouvé par la CI
Windows au premier passage de 5.2, puis mesuré : 67 paires sur 20 000.

## Dépendance

`ssh2` (pur JavaScript). Ses modules natifs facultatifs (`cpu-features`,
liaison crypto) ne sont pas compilés — npm 11 n'exécute pas leurs scripts
d'installation sans accord — et il s'en passe.

## Tests

`tests/unit/remote.test.ts`, face à `tests/fake-ssh-server.ts` : un hôte
`ssh2` dans le processus, au petit langage de commandes (`echo`, `stderr`,
`exit`, `sleep`, `flood`), SFTP adossé à un vrai dossier (dossier personnel
`/C:/Users/<compte>`, `lstat` qui voit les liens, listes, effacements). Il
compte les tentatives d'authentification, les canaux fermés avant leur fin
et chaque effacement reçu.
