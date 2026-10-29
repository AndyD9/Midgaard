# `@midgaard/tools`

Les outils des agents. Tous en **lecture seule** en Slice 2 : aucune écriture,
aucun shell. L'écriture, `git` et `exec` arrivent en Slice 3, avec les worktrees
qui les rendent réversibles.

| Outil | Rôle |
|---|---|
| `read_file` | Un fichier texte du projet |
| `list_directory` | Le contenu d'un dossier, sans récursion |
| `search_files` | Une expression régulière sur les fichiers d'un **répertoire** du projet |
| `http_fetch` | Une URL publique, HTML converti en texte |
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
