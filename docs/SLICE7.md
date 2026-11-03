# Slice 7 — Les agents voient : images, puis un navigateur isolé

**Date :** 2026-11-03 · **Objectif :** qu'un agent puisse **lire une image** —
une capture, une maquette, un schéma du projet — puis **se servir d'un
navigateur** : ouvrir une page ou une application web, la regarder, cliquer,
saisir. Le tout dans un navigateur que le daemon lance à part, sous des
sessions que l'humain approuve et surveille en direct dans l'atelier.

**État : en cours.** Étape 1 faite (2026-11-03), sur réponses enregistrées ;
le passage d'une image contre l'API réelle reste à constater.

---

## Ce que la Slice 7 renverse

Jusqu'ici, un agent ne lit que du texte : fichiers, pages converties en texte
(`http_fetch`), sorties de commandes. Et il n'agit sur le monde que par trois
portes, chacune gardée : l'écriture dans son worktree, `exec` sous approbation,
la délégation. Un agent qui **voit un écran et agit dessus** ouvre une
quatrième porte, la plus large : une page web contient tout ce qu'un humain
peut y faire, et une image peut porter un texte qui cherche à détourner
l'agent. C'est pour cela que l'ordre est imposé : les images d'abord, qui ne
font rien ; le navigateur ensuite, qui agit.

## Les décisions prises avec l'auteur (2026-11-03)

| Question | Réponse retenue |
|---|---|
| Par quoi commencer ? | **Les images d'abord**, puis le pilotage, dans la même slice |
| Où l'agent « utilise l'ordinateur » ? | **Un navigateur isolé**, lancé par le daemon, sans les sessions ni les cookies de l'utilisateur. Jamais son vrai bureau |
| Que veut dire « utiliser des applications » ? | **Les ouvrir et s'en servir à l'écran.** Dans un navigateur isolé, ce sont des **applications web** ; les applications natives demanderaient une machine virtuelle, hors de cette slice |
| Comment approuver les actions à l'écran ? | **Une session approuvée, surveillée** : l'humain approuve une session (objectif, durée), voit l'écran en direct et peut couper ; saisir du texte et valider restent approuvés à chaque fois |

## Ce que le code offre déjà

- **Venice publie la capacité de chaque modèle** dans son catalogue public
  (`/models`, `model_spec.capabilities.supportsVision`) : relevé le
  2026-11-03, 96 modèles sur 139 lisent les images. **Le modèle des essais de
  la Slice 6, `deepseek-v4-flash-0731`, n'en fait pas partie.** Parmi ceux qui
  lisent les images **et** appellent des outils : `mistral-small-3-2-24b-instruct`
  (0,094 $ / 0,25 $ par million de jetons), `qwen-3-8-flash`, `google-gemma-3-27b-it`.
- **Playwright est déjà une dépendance** du dépôt, de développement seulement
  (`test:ui`) ; Chromium s'installe par `npx playwright install chromium`.
- **La garde réseau** d'`http_fetch` (`tools/src/net.ts` : adresses privées,
  IMDS, redirections) et **la garde des processus** (`tools/src/guard.ts`) sont
  réutilisables pour le navigateur.
- **Les approbations** portent déjà sur une opération préparée, avec empreinte ;
  **le terminal et l'éditeur de l'atelier** montrent déjà le travail en direct
  (Slice 6).
- Manquent : un message qui porte une **image** (`Message.content` n'est que du
  texte, `providers/src/adapter.ts`), la **capacité** d'un modèle, un paquet
  qui pilote un navigateur, et une approbation qui porte sur **une session**
  plutôt que sur une opération.

## Décisions de conception

1. **Une image n'est jamais écrite en base.** Le journal garde son chemin, sa
   taille, son type et son empreinte (SHA-256), jamais ses octets. Une image
   peut montrer un secret — une capture d'écran surtout —, et l'expurgation ne
   sait pas lire une image.
2. **La capacité « vision » est constatée, pas supposée.** Lue dans le
   catalogue du fournisseur quand il la publie (Venice) ; sinon déclarée par
   l'utilisateur pour un profil, et dite comme telle. Sans elle, `read_image` et
   les outils du navigateur sont **refusés avec leur motif**, comme un profil
   sans fournisseur : jamais une image envoyée à un modèle qui l'ignorerait, en
   la facturant.
3. **L'image passe par un message utilisateur.** L'API Chat Completions
   n'admet pas d'image dans un message de rôle `tool`, et Gemini pas davantage
   dans une `functionResponse`. Le résultat de l'outil dit « image jointe »,
   et l'image suit, dans un message utilisateur que la boucle ajoute. La
   normalisation reste dans chaque adaptateur, jamais dans la boucle (PLAN §4).
4. **Une image du projet n'est pas encadrée ; une capture d'une page l'est.**
   Comme pour le texte : un fichier du dépôt n'est pas plus suspect que le
   dépôt, une page web l'est. Une image ne se met pas entre balises : la tâche
   qui en a reçu une venue du navigateur est **marquée non fiable**, comme si
   elle avait lu la page (règle de la Slice 5).
5. **Le navigateur est jetable et sans privilège.** Un Chromium par session,
   profil vierge, sans extension, sans téléchargement, sans permission
   (caméra, micro, géolocalisation, notifications, presse-papiers). Toute
   requête passe par la garde réseau d'`http_fetch` : adresses privées, IMDS et
   redirections vers elles refusées. Il meurt avec la session, la tâche, et
   avec le daemon — y compris tué net (la garde des processus, comme `exec`).
6. **La session est l'approbation.** `browser_open` prépare une session —
   objectif, adresse de départ, durée maximale — que l'humain approuve. Dans la
   session, regarder, faire défiler et cliquer sont libres ; **saisir du texte
   et presser Entrée sont approuvés chacun**, avec le texte exact : c'est par là
   qu'un formulaire part. L'humain coupe la session quand il veut, et elle
   expire seule.
7. **L'humain voit ce que voit l'agent.** Un onglet « Navigateur » dans
   l'atelier montre la dernière capture, au fil des actions. Les captures
   restent **en mémoire** (décision 1) ; le journal raconte l'adresse et
   l'action, pas l'image.
8. **Un profil dédié**, plutôt que d'étendre le Researcher ou le Developer :
   ses outils, sa consigne et son budget (les images coûtent des jetons) lui
   sont propres, et le désactiver coupe tout le pilotage d'un coup.
9. **Pas de machine virtuelle ni d'application native** dans cette slice. Le
   besoin se confirmera, ou non, à l'usage du navigateur.

## Découpage

| # | Étape | État |
|---|---|---|
| 1 | Contrats et adaptateurs : contenu image dans `Message`, OpenAI-compatible (`image_url`) et Gemini (`inline_data`) sur réponses enregistrées, capacité « vision » lue au catalogue ou déclarée | **fait** — sauf l'API réelle ; la déclaration par profil passe à l'étape 2 |
| 2 | `read_image` : types reconnus par leurs premiers octets (PNG, JPEG, WebP, GIF), taille plafonnée, chemin vérifié comme `read_file`, refus sans vision ; l'image suit le résultat d'outil ; rien de l'image en base | à faire |
| 3 | Le paquet `browser` : Chromium jetable par Playwright, garde réseau, sans téléchargement ni permission, processus tués à la fin et après `SIGKILL` | à faire |
| 4 | Les outils et la session : `browser_open` (session approuvée), `browser_screenshot`, `browser_click`, `browser_scroll`, `browser_type` et `browser_key` (approuvés chacun), `browser_close` ; captures non fiables | à faire |
| 5 | Le profil `navigator` : consigne, outils, limites ; désactivé sans modèle à vision, avec son motif | à faire |
| 6 | L'atelier : onglet « Navigateur » (dernière capture en direct, adresse, bouton « Couper la session »), l'image lue montrée dans le fil | à faire |
| 7 | Preuves : unitaires, de bout en bout sur une page locale servie par le test, `test:security` (adresse privée depuis le navigateur, saisie sans approbation, aucun Chromium vivant après `SIGKILL`, aucune image en base), CI sur trois plateformes | à faire |
| 8 | L'essai réel : un agent lit une maquette, puis navigue dans une application web, sous session approuvée, coût comparé à la facture | à faire |

### Ce que chaque étape doit surveiller

- **Étape 1.** Vérifier contre l'API réelle qu'une image passe, et ce qu'elle
  coûte : les réponses enregistrées ne prouvent que la forme. La dette Gemini
  de la Slice 2 (jamais éprouvé contre l'API réelle) touche aussi les images.
- **Étape 2.** Une extension ment : le type se lit dans les octets. Et un
  fichier énorme se refuse avant d'être lu en entier.
- **Étape 3.** Compter les processus Chromium vivants après chaque fin,
  `SIGKILL` du daemon compris : c'est ainsi que la garde d'`exec` a été prouvée.
- **Étape 4.** Une approbation de session porte sur une **opération préparée**
  et son empreinte, comme les autres : objectif, adresse, durée. Une saisie
  approuvée porte sur son texte exact.
- **Étape 8.** Le solde du compte Venice bouge sous un autre usage (Slice 6) :
  une clé sur un compte dédié, ou l'essai ne compare pas au solde, et le dit.

## Récit

### Étape 1 — les images dans la conversation (2026-11-03)

**Un champ de plus, pas une autre forme.** Un message utilisateur garde son
`content` texte et gagne `images` (base64, type parmi PNG, JPEG, WebP, GIF).
Changer `content` en liste de parties aurait obligé à retoucher chaque endroit
qui écrit un message — la boucle, le contexte, les tests — pour un cas qui ne
concerne que les images. Les messages d'avant se traduisent à l'identique : un
test le fixe pour l'API compatible OpenAI.

**Chaque adaptateur traduit, la boucle n'en sait rien.** L'image devient une
partie `image_url` en URL `data:` (une URL externe ferait télécharger l'image
par le fournisseur, et la page d'origine le saurait) ou une partie
`inlineData` à côté du texte chez Gemini. La règle du PLAN §4 tient : les
différences de fil restent dans les adaptateurs.

**La capacité est lue, pas devinée.** `capabilities()` lit `supportsVision`
dans le catalogue Venice, une fois par heure ; il rend `null` pour un modèle
absent du catalogue, pour un catalogue en panne, et chez OpenAI ou un endpoint
`custom`, qui ne publient rien. Deviner d'après le nom (`-vl`, `vision`) aurait
manqué presque tous les modèles relevés : sur les 96 qui lisent les images,
quatre seulement le disent dans leur nom (`qwen3-vl-235b-a22b`,
`z-ai-glm-5v-turbo`, `nvidia-nemotron-3-5-super-vl-120b-a12b`,
`e2ee-qwen3-vl-30b-a3b-p`) ; `gemini-3-7-flash` ou `mistral-small-3-2-24b-instruct`
les lisent sans le dire.

**Déplacé à l'étape 2 :** la **déclaration** de la capacité par un profil,
quand le fournisseur ne la publie pas. Elle ne sert qu'au refus de
`read_image`, et se conçoit avec lui.

**Vérifié :**
- `npm run typecheck` ;
- 6 tests sur réponses enregistrées (`providers.test.ts`, « images et
  capacité ») : la forme exacte des deux fils, un message sans image
  inchangé, le catalogue lu (vrai, faux, non publié, modèle absent), gardé une
  heure, illisible sans échec, et aucune requête chez OpenAI ;
- `npm run test:unit` : 492 tests.

**Pas encore constaté :** qu'une image passe réellement chez Venice, et ce
qu'elle coûte. C'est la vigilance de cette étape ; il faut un appel payant
(une fraction de centime) à un modèle qui lit les images.

