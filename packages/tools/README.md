# `@midgaard/tools`

Les outils des agents. Ceux de la Slice 2 **lisent** ; ceux de la Slice 3
**écrivent ou exécutent, mais seulement dans le worktree** de la tâche, et
refusent partout ailleurs.

| Outil | Rôle |
|---|---|
| `read_file` | Un fichier texte du projet |
| `list_directory` | Le contenu d'un dossier, sans récursion |
| `search_files` | Une expression régulière sur les fichiers d'un **répertoire** du projet |
| `http_fetch` | Une URL publique, HTML converti en texte |
| `write_file` | Crée ou remplace un fichier du **worktree** |
| `edit_file` | Remplace un passage exact d'un fichier du worktree |
| `delete_file` | Supprime un fichier du worktree (jamais un dossier) |
| `git_diff` | Ce que l'agent a changé depuis le début de la tâche, fichiers nouveaux compris |
| `exec` | Une commande dans le worktree, **sous approbation humaine** par défaut |
| `submit_result` | **Le seul outil qui termine une tâche** |

## Ce que ce paquet garantit, et ce qu'il ne garantit pas

**Ce n'est pas une sandbox.** Le daemon tourne sous le compte de l'utilisateur ;
un agent qui contournerait ce module lirait tout ce que l'utilisateur peut lire.
C'est une **frontière d'intention** : elle empêche un agent qui dérape — ou
qu'une page web manipule — d'aller fouiller ailleurs que dans le dépôt d'où la
tâche a été déléguée. Le modèle de menace complet est dans
[`packages/daemon/README.md`](../daemon/README.md).

## Chemins : la fenêtre que `openUnderRoot` ferme

La vérification naïve — résoudre, comparer à la racine, ouvrir — laisse une
fenêtre : entre la comparaison et l'ouverture, le chemin peut changer de cible
(*TOCTOU*). Le plan (§5) l'exigeait explicitement : vérifier « **à l'ouverture du
descripteur, pas seulement avant** ».

`openUnderRoot` résout, vérifie, ouvre, puis **compare `dev` et `ino` du `fstat`
du descripteur ouvert** à ceux du `stat` d'avant. Si la cible a été substituée
entre-temps, l'identité ne correspond plus et l'ouverture est refusée.

Le message de refus ne dit jamais **où** menait le lien : un agent manipulé par
un contenu web n'a pas à apprendre l'arborescence de la machine.

## Un refus vaut mieux qu'un faux négatif

`search_files` cherche dans un **répertoire**. Si on lui passe un chemin de
fichier, il **refuse en disant quoi faire** — chercher dans le répertoire parent,
ou lire le fichier avec `read_file`.

Il a longtemps répondu « aucune correspondance » à la place : `readdir` lève
`ENOTDIR` sur un fichier, et le `catch` qui rend la marche tolérante aux
dossiers illisibles avalait l'erreur à la racine de la recherche. Le défaut a
été trouvé en vraie session : un agent a cherché un symbole **qui existait**,
l'a cru absent sur la foi de ce zéro, a reformulé quatre fois et y a laissé son
budget d'étapes.

La leçon est plus générale que l'outil : **un faux négatif est pire qu'un
refus**, parce qu'il a l'air d'une réponse. Un modèle ne peut pas distinguer
« je n'ai rien trouvé » de « je n'ai rien cherché » — alors l'outil doit le
faire pour lui. La tolérance reste là où elle a un sens : un sous-dossier
illisible n'interrompt toujours pas une recherche en cours.

## Écrire : deux serrures, et aucune approbation à la place

Un outil d'écriture ne fait rien si le contexte ne porte pas `writable: true`,
ce que le daemon ne pose que lorsque la racine **est** le worktree de la tâche.
Sans lui — le Researcher, ou un profil qui aurait reçu `write_file` par
erreur — la politique **refuse**, sans demander d'approbation. Transformer ce
refus en demande apprendrait à cliquer « oui » ; et écrire hors d'un worktree
n'est pas réversible, donc pas négociable (PLAN §5). Le champ est facultatif et
**fermé par défaut** : un contexte construit sans y penser ne peut rien écrire.

Dans le worktree, écrire est autorisé sans approbation : tout y est réversible
jusqu'au merge, qui est humain.

### Ce que `openForWrite` vérifie

La cible d'une écriture n'existe souvent pas encore : `realpath` ne peut pas la
canonicaliser. Six vérifications, dans l'ordre :

1. le chemin lexical reste sous la racine ;
2. **aucun segment `.git`**, casse ignorée. Dans un worktree, `.git` est un
   fichier qui dit à Git où est le dépôt : le réécrire redirigerait chaque
   commande du harness — commit de fin compris — vers un autre dépôt ;
3. le plus proche dossier existant a un chemin réel sous la racine (un
   dossier-lien qui mène dehors est arrêté là) ;
4. la cible n'est **pas un lien symbolique**, même vers un fichier de la racine ;
5. la cible, sur son chemin réel, n'est **pas dans un sous-module**
   (`ToolContext.workspace.submodules`) : le worktree les laisse vides, et ce
   qu'on y écrit est ignoré **sans un mot** par le `git add -A` du commit de fin
   — constaté. L'agent croirait avoir livré un fichier que la branche n'a pas ;
6. après ouverture avec `O_NOFOLLOW`, le descripteur désigne un fichier
   ordinaire et le dossier parent a gardé son identité et son chemin réel.

Le fichier est ouvert **sans** `O_TRUNC` et vidé une fois tout vérifié : un refus
tardif ne doit pas avoir détruit ce qu'il refuse. `delete_file` supprime un lien
**lui-même**, jamais sa cible.

**Sous Windows**, `O_NOFOLLOW` n'existe pas. Le `lstat` de l'étape 4 reste seul,
avec une fenêtre étroite entre lui et l'ouverture. Contre-épreuve faite : chacune
des deux serrures, seule, suffit à faire passer les tests de liens.

`edit_file` recompose le texte à la main au lieu d'appeler `replace` :
`String.replace` interprète `$&` et `$1` dans le texte de remplacement, et du
code contient des `$`. Un test le verrouille.

**Fins de ligne.** `edit_file` tient `\n` et `\r\n` pour équivalents en
cherchant `old_string`, et écrit `new_string` avec la fin de ligne du passage
remplacé (CRLF dès qu'il en contient ; à défaut, celle qui domine le fichier).
Sous Windows, Git convertit le worktree en CRLF au checkout, et un modèle écrit
`\n` : la recherche octet pour octet ne trouvait rien (docs/SLICE3.md, leçon
n° 20). Rien d'autre n'est relâché — l'unicité se compte sur la recherche
tolérante, si bien qu'un passage présent une fois en LF et une fois en CRLF est
ambigu, pas tranché au hasard. Le résultat dit au modèle quand des fins de ligne
ont été adaptées. `write_file`, lui, écrit ce qu'on lui donne.

## `git_diff` : le seul accès à Git, en lecture

L'agent ne commite pas : c'est le harness qui le fait à `submit_result`, et la
branche ne bouge qu'à ce moment-là. `status` et `log` n'apprendraient rien que
ce diff ne dise. Et un outil `git` à arguments libres exposerait `-c`,
`--upload-pack`, `--output` et les alias de la configuration ; un outil qui ne
prend aucun argument n'a rien à filtrer. Le diff vient de `@midgaard/workspace`,
qui ne lance ni hook ni pilote désigné par l'arbre de travail.

## `exec` : l'approbation est la frontière

`exec` n'est **pas une sandbox**. La commande tourne sous le compte de
l'utilisateur, avec son dossier personnel : elle lit ce qu'il lit et joint le
réseau. La frontière est humaine — chaque commande attend une approbation, et
l'humain lit **exactement** ce qui va tourner :

```text
exec — exécuter /opt/homebrew/bin/npm test -- --grep 'a b' dans /Users/…/worktrees/app-1a2b3c4d/0b9f3c2e/packages/api (délai 120 s)
```

Ce texte vient de `prepare`, qui fige l'opération **avant** la demande. `run`
exécute ce qui a été figé, après avoir revérifié que le binaire est toujours le
même fichier (périphérique, inœud, taille, date) : la demande peut attendre dix
minutes, et le monde change pendant ce temps. L'empreinte de l'approbation est
tirée du détail structuré (`operation_detail`), pas de ce texte.

Les guillemets ne servent qu'à l'affichage : `["a;b"]` et `["a", ";", "b"]` ne
doivent pas s'afficher pareil, sinon l'on approuve l'un en lisant l'autre.

**Pourquoi pas une liste blanche d'office** : l'agent écrit dans son worktree,
donc dans `package.json`. Autoriser `npm test` sans regard, c'est autoriser ce
qu'il a mis dans `scripts.test`. `MIDGAARD_EXEC_ALLOW` existe — des argv
**exacts**, séparés par `;` (`npm test;npx tsc --noEmit`) — vide par défaut, et
le daemon rappelle la conséquence dans son journal à chaque démarrage. Pas de
guillemets dans cette variable : un argument contenant une espace ne peut pas
être mis en liste blanche, et c'est voulu.

| Garantie | Comment |
|---|---|
| Aucun shell | `spawn` sans `shell` : `;`, `\|`, `$()` restent des caractères |
| Ce qu'on approuve est ce qui tourne | le binaire est **résolu par le harness** avant la demande (`prepare`) et **revérifié** avant de lancer ; les entrées **relatives** du `PATH` sont ignorées |
| Uniquement dans un worktree | sans `ToolContext.writable`, refus sans demande |
| Pas de secrets du daemon | environnement reconstruit (`execEnv`) ; `CI=1`, `NO_COLOR=1` imposés |
| **Aucun processus ne survit** | groupe de processus propre, tué à la sortie, au délai (`SIGTERM`, puis `SIGKILL` après 2 s) et à l'annulation — et par la **garde** si le daemon meurt net |
| Pas au-delà de la tâche | délai plafonné par l'échéance de la tâche (`ToolContext.deadline`) |
| Sortie bornée | 8 Ko + 32 Ko de fin pour stdout, 4 Ko + 12 Ko pour stderr ; le retrait du milieu est écrit |
| Sortie encadrée | `untrusted: true` : une sortie de commande peut contenir n'importe quoi |

Un code de sortie non nul **n'est pas une erreur** : un test qui échoue est une
réponse, que l'agent doit lire pour corriger son code.

Pourquoi tuer le groupe **même quand la commande sort normalement** : sans
cela, un `npm run dev` ou un `sleep 999 &` survivrait à la tâche, et le harness
attendrait indéfiniment que ces survivants ferment les tubes de sortie. Le test
le vérifie en interrogeant le pid du petit-enfant au système.

**Sous Windows**, trois limites, annoncées plutôt que contournées :

- `npm`, `npx` et tout script `.cmd`/`.bat` sont **refusés** : Node ne les lance
  plus sans shell (CVE-2024-27980), et `cmd.exe` a des règles d'échappement qui
  ne se maîtrisent pas. Lancer `node` avec le chemin du script fonctionne ;
- l'arbre de processus est tué par `taskkill /T`, qui ne retrouve plus les
  enfants d'un parent déjà sorti. **Nuance constatée en CI** : le test du
  petit-enfant laissé par une commande sortie passe pourtant sous Windows,
  vraisemblablement parce que libuv place ses enfants dans un *Job Object* qui
  les tue avec leur parent. Non constaté pour un programme qui ne passe pas par
  libuv ;
Le reste — chemins, liens, `.git`, `exec`, résolution par `PATHEXT`, fins de
ligne d'`edit_file` dans un vrai dépôt en CRLF — tourne en
CI sur macOS, Linux et Windows (`.github/workflows/worktrees.yml`).

Un processus qui quitte volontairement son groupe (`setsid`) échappe aussi au
nettoyage, sur toutes les plateformes : c'est la limite d'un contrôle sans
sandbox.

### La garde : quand le daemon meurt net

Les trois moments où `exec` tue un groupe supposent que le daemon vit encore.
Tué par `SIGKILL`, il ne tue plus rien, et le groupe — détaché de lui pour
pouvoir être tué entier — continue : constaté, une commande a écrit dans le
worktree trois secondes après la mort du daemon. `guard.ts` lance donc, à la
première commande, **un** processus de garde dans son propre groupe. Le daemon
lui inscrit chaque groupe lancé (`+pid`) et le retire une fois tué (`-pid`) sur
un tube. Quand le daemon meurt, le système ferme le tube, quelle que soit la
manière ; la garde lit la fin du flux et tue les groupes encore inscrits.

Pas de `prctl(PR_SET_PDEATHSIG)` (Linux seulement, et Node ne l'expose pas), pas
de pid persistés pour les tuer au redémarrage (un redémarrage de la machine les
rend à d'autres processus). Si la garde ne démarre pas, le journal du daemon le
dit une fois et `exec` fonctionne comme avant. Éprouvé par `exec.test.ts` (un
lanceur tué par `SIGKILL`, sa commande doit mourir) et par V12 dans
`test:developer` (un vrai daemon). Sous Windows, elle passe par `taskkill /T` :
**pas encore constaté**, ce sera l'étape 5 de la Slice 4.

## `http_fetch`

Quatre contrôles, chacun contre une menace précise :

1. **Schéma** — `http` et `https` seulement. `file://` ferait de `http_fetch` un
   lecteur de disque sans racine.
2. **Destination publique, à chaque saut.** Les redirections sont suivies à la
   main (`redirect: 'manual'`) : laisser `fetch` suivre ne contrôlerait que la
   première URL, et une redirection vers `169.254.169.254` passerait sans que
   rien ne la voie. Boucle locale, plages privées, lien-local (donc l'IMDS), NAT
   d'opérateur, multicast — refusés, en v4 comme en v6, `::ffff:127.0.0.1`
   compris.
3. **Taille**, coupée *pendant* la lecture : `content-length` est facultatif, et
   un serveur hostile ment.
4. **Type textuel** — un binaire réinjecté coûte une fortune en jetons.

**Limite connue** : on résout le nom, on vérifie toutes les adresses, puis
`fetch` résout une seconde fois. Un DNS à très faible TTL peut théoriquement
rendre une adresse publique à la vérification et privée à la connexion (*DNS
rebinding*). Fermer cette fenêtre demanderait de réimplémenter la couche de
transport ; c'est dit plutôt que sous-entendu.

### Politique des hôtes

| `MIDGAARD_HTTP_POLICY` | Hôte hors liste blanche |
|---|---|
| `open` (défaut) | autorisé s'il est public |
| `approval` | suspend la tâche, demande un humain |
| `allowlist` | refusé |

Le plan (§5) prévoyait la liste blanche seule. En pratique, un Researcher qui ne
peut lire que des domaines prévus d'avance ne sert à rien : personne ne connaît
à l'avance l'URL de la documentation qu'il faudra consulter. Le mécanisme existe,
le réglage aussi (`MIDGAARD_HTTP_ALLOW`), et le défaut est **annoncé** plutôt
que présenté comme une liste blanche qui n'en serait pas une. Les adresses
privées restent refusées dans les trois cas.

## `web_search` n'est pas un outil appelable

Chez Venice, la recherche web est un **drapeau de requête**
(`venice_parameters.enable_web_search`), pas une fonction que le modèle appelle.
En faire un outil exigerait un appel de modèle **supplémentaire** par recherche,
donc de payer deux fois ce que le fournisseur fait en une.

Il reste dans la liste d'outils d'un profil, où il agit comme l'interrupteur qui
active la recherche native, sans jamais être proposé au modèle. La boucle
journalise un appel `web_search` **a posteriori** dès que des citations
reviennent : observable, compté, attribué.

## `submit_result` : la fin est un acte

Une boucle qui s'arrêterait sur « le modèle n'a demandé aucun outil » s'arrêterait
aussi quand il réfléchit à voix haute, quand il pose une question, ou quand il
s'excuse. On récupérerait du texte libre là où Claude attend un résultat
exploitable, sans savoir distinguer « fini » de « coincé ».
