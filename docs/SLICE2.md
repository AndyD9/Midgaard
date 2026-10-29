# Slice 2 — Agents réels

**Date :** 2026-10-29 · **Objectif :** faire tourner de **vrais** agents — des
fournisseurs derrière une interface commune, une boucle avec budgets et limites,
des outils de lecture contrôlés, un coffre pour les clés, et un coût qui
corresponde à la facture.

**État : livrable atteint, mesuré, et éprouvé en vraie session.** Un Researcher
exécute de vraies tâches sur Venice, et **le coût affiché correspond au centime
près au solde débité** — vérifié **trois** fois, à 0,0 % d'écart, en relevant le
solde chez le fournisseur avant et après. 126 vérifications unitaires, 10
d'instance unique, 7 d'intégration, 12 de bout en bout MCP et 5 d'essai réel,
0 échec.

L'essai en vraie session Claude Code, que la version précédente de ce document
annonçait comme restant à faire, **a eu lieu** : il confirme les invariants — une
attente de 62,6 s sans coupure dans le vrai client, le `context` qui évite la
redécouverte, le web encadré et sourcé — et **rapporte quatre défauts
d'ergonomie**. Le premier — `search_files` qui rendait « 0 correspondance »
sur un chemin de fichier — **est corrigé**, avec son test de non-régression. Les
trois autres sont consignés pour que l'auteur tranche.

Ce qui n'a **pas** encore eu lieu est dit tel quel au § « Limites connues » :
aucune ligne de ce document ne décrit quelque chose qui n'existe pas.

---

## Les décisions prises avec l'auteur

Trois questions ont été posées avant d'écrire une ligne, parce que trois
réponses différentes auraient donné trois produits différents.

| Question | Réponse retenue |
|---|---|
| Quel fournisseur pour l'essai réel ? | **Venice.ai** |
| Recherche web du Researcher (point laissé ouvert, PLAN §9.3) | **Native au fournisseur**, crochets OpenAI et Gemini écrits mais non exécutés |
| Coffre système | **Multi-plateforme obligatoire**, Windows compris |

La première a eu la conséquence la plus structurante, et elle n'était pas
prévisible : **Venice expose une API compatible OpenAI**.

---

## Ce que Venice change au plan

### Un adaptateur de moins

Le plan voulait un adaptateur OpenAI et un adaptateur Gemini, pour éprouver
l'interface contre deux protocoles réellement différents. Venice parle le
protocole d'OpenAI — mêmes `messages`, mêmes `tools`, mêmes `tool_calls`, même
`finish_reason`. Ce n'est donc pas un troisième adaptateur, mais le même avec
une autre `base_url` et un objet d'extension.

D'où une distinction qui n'était pas au plan et qui porte tout le reste :

- **`kind`** dit *comment on parle* — la forme du fil, donc l'adaptateur ;
- **`preset`** dit *à qui on parle* — l'endpoint, donc les tarifs, les
  extensions disponibles et la clé de tarif.

L'intention du plan est préservée : Gemini reste la seconde forme de fil, et
c'est elle qui prouve que l'interface en est une.

### Le coût cesse d'être une promesse

Le livrable exigeait que « le coût affiché corresponde à la facture ». Avec un
tableau de tarifs maintenu à la main, c'est une promesse invérifiable : il
vieillit, et personne ne s'en aperçoit parce qu'il produit toujours un montant
plausible.

Venice renvoie **`cost.usd` sur chaque réponse**, et publie
`model_spec.pricing` sur `GET /models`. Deux conséquences :

1. On garde **deux** montants côte à côte — celui qu'on calcule et celui que le
   fournisseur annonce — et `cost_source` dit lequel est affiché. L'écart entre
   les deux est ce qui révèle une table périmée. Sans les deux, la dérive serait
   invisible ;
2. `harness pricing refresh venice` reconstruit la table depuis l'API. Un tarif
   relevé chez le fournisseur ne peut pas avoir dérivé.

Et une règle qui vaut partout : un modèle sans tarif connu rend
`cost_source: 'unknown'`, jamais `0 $`. **Zéro est un coût, pas une ignorance.**

### La recherche web, tranchée

Le point 3 du §9 du plan — « fournisseur de recherche web pour le Researcher et
son modèle de facturation » — est refermé : **recherche native du fournisseur**.

Chez Venice, c'est `venice_parameters.enable_web_search`, facturé 0,01 $ la
requête sur le même solde, avec `enable_web_citations` qui rend des citations
**structurées** (`title`, `url`, `content`, `date`). Ce dernier point n'est pas
un détail : un bloc `{title, url}` s'encadre proprement en `<untrusted_data>`,
du texte libre beaucoup moins.

Les alternatives écartées, et pourquoi : une API tierce (Brave, Tavily, Exa)
aurait coûté un compte, un secret de plus dans le coffre et une ligne de tarif
hors modèle, sans rien apporter de plus ; les recherches natives d'OpenAI et de
Gemini exigent des clés qui n'existent pas encore.

**Conséquence de conception** : `web_search` n'est **pas** un outil appelable.
C'est un drapeau de requête, pas une fonction. En faire un outil exigerait un
appel de modèle supplémentaire par recherche — payer deux fois ce que le
fournisseur fait en une. Il reste l'interrupteur du profil, et la boucle
journalise un appel `web_search` *a posteriori* dès que des citations
reviennent : observable, compté, attribué, sans surcoût.

---

## Écarts au plan, et leurs raisons

Quatre, chacun assumé et documenté sur place.

### 1. Aucun SDK de fournisseur

Le plan (§1) verrouillait `openai` et `@google/genai`. Les deux adaptateurs
tapent l'API HTTP directement.

1. On n'appelle **qu'un endpoint par fournisseur**, sans flux ;
2. il faut **contrôler le corps au champ près** — Venice refuse en 400 tout
   champ de premier niveau inconnu, et attend son extension propre ;
3. **une seule discipline HTTP** (délai, reprise, annulation, expurgation) au
   lieu de trois comportements à connaître ;
4. les SDK **bougent** : la Slice 0 avait déjà relevé que `@google/genai` ≥ 2
   change la forme des appels.

C'est le raisonnement qui avait fait préférer `node:http` à Fastify et
`node:sqlite` à `better-sqlite3`. Le prix est assumé : les erreurs de l'API,
c'est nous qui les interprétons. **Résultat : la Slice 2 n'ajoute aucune
dépendance d'exécution.**

### 2. Pas de table `usage`

Le plan (§6) la prévoyait. Le cumul vit dans `tasks.usage_json`, et son
historique dans le journal, où chaque `usage.updated` porte le cumul du moment.
Une troisième copie n'aurait ajouté qu'une cohérence de plus à tenir.

### 3. La liste blanche HTTP n'est pas le seul mode

Le plan (§5) imposait une liste blanche de domaines. Un Researcher qui ne peut
lire que des domaines prévus d'avance ne sert à rien : personne ne connaît à
l'avance l'URL de la documentation qu'il faudra consulter.

`MIDGAARD_HTTP_POLICY` propose donc trois modes — `open` (défaut), `approval`,
`allowlist` — et le défaut est **annoncé** plutôt que présenté comme une liste
blanche qui n'en serait pas une. Les adresses privées et l'IMDS restent refusées
dans les trois cas, sans dérogation possible.

### 4. Un paquet `secrets` qui n'était pas à l'arborescence

Le plan (§2) ne le prévoyait pas. Le coffre est une préoccupation séparable, qui
servira au-delà des clés de fournisseurs, et le mettre dans `providers` aurait
mêlé « parler à un modèle » et « garder un secret ».

---

## Le coffre, et ce qu'il promet vraiment

| Plateforme | Mécanisme | Protégé par l'OS | Le secret passe par |
|---|---|---|---|
| macOS | `security` — trousseau | oui | argument (voir ci-dessous) |
| Windows | PowerShell `ConvertFrom-SecureString` — DPAPI | oui | entrée standard |
| Linux | `secret-tool` — libsecret | oui | entrée standard |
| partout | repli fichier `0600` | **non** | — |

`SecretVault.osBacked` porte cette dernière colonne, et `harness doctor`
l'affiche : un repli fichier est annoncé comme tel, jamais présenté comme un
coffre.

**Aucune dépendance native**, comme `node:sqlite` en Slice 1. `keytar` aurait
demandé un binaire précompilé ou un compilateur ; le Credential Manager de
Windows sait écrire un identifiant mais **pas relire un mot de passe** —
délibérément — et le module PowerShell qui le permettrait n'est pas installé
d'office.

**Limite assumée** : `security add-generic-password` n'accepte le mot de passe
qu'en argument ; il est donc visible dans `ps` pour les processus du **même**
utilisateur, le temps de l'écriture. Ceux-là peuvent de toute façon lire le
jeton du daemon dans `~/.midgaard/daemon.json`, ce qui est déjà hors du modèle
de menace. La lecture, elle, n'expose rien.

---

## Trois bogues que seule l'exécution a révélés

Aucun des trois ne se voyait à la lecture. Tous les trois ont été trouvés en
faisant tourner le code, et chacun a donné un test.

### 1. Le trousseau macOS rend l'hexadécimal sans le dire

`security find-generic-password -w` rend le mot de passe **en hexadécimal** —
sans préfixe, sans signalement — dès qu'il contient un octet non imprimable en
ASCII. Un aller-retour naïf rendait `736b2d…` au lieu de la clé, et corrompait
silencieusement toute clé non anglaise.

Deviner à la relecture est impossible : `abcdef` est un mot de passe valide
**et** de l'hexadécimal valide. L'ambiguïté est donc supprimée à l'écriture, en
ne déposant que de l'ASCII imprimable (`mg1:` + base64).

### 2. L'expurgation ne masquait pas les jetons porteurs

La fonction de remplacement prenait l'argument `string` de `String.replace` —
le **texte entier** — pour un groupe de capture, et cherchait donc tout le
document à l'intérieur du seul motif trouvé. Le motif `Bearer` ne remplaçait
rien. Second défaut au même endroit : une longueur fixe sur les clés Google
laissait en clair la **queue** d'une clé plus longue, c'est-à-dire exactement ce
qu'il ne faut pas laisser.

### 3. Une racine de projet sous un lien symbolique rejetait ses propres fichiers

La vérification de chemin compare un chemin réel à la racine autorisée. Si la
racine n'est pas canonicalisée, un projet situé sous un lien symbolique — ce
qu'est `/tmp` sur macOS, et ce que sont bien des dossiers personnels — voit
chacune de ses lectures refusée « hors du projet », pour des fichiers qui en font
partie. La racine est désormais canonicalisée dans la boucle, une fois.

---

## Et un quatrième, trouvé en éprouvant le chemin complet

Celui-là est le plus intéressant, parce qu'il a été trouvé **en testant avec une
fausse clé** — un test qui aurait pu passer pour superflu.

Le « Test connection » annonçait **« joignable »** avec une clé bidon. Vérifié
ensuite à la main contre la vraie API : `GET /api/v1/models` de Venice répond
`200` **sans aucun en-tête d'autorisation**. Le test ne prouvait donc rien de la
clé, et l'utilisateur ne l'aurait découvert qu'à sa première délégation, loin de
la cause.

C'est le défaut n° 1 de la Slice 0 sous une autre forme : **affirmer que quelque
chose marche sans l'avoir constaté.**

Correction : une sonde **authentifiée** par préréglage.
`GET /api_keys/rate_limits` rend `401 Authentication failed` sur une clé
invalide (mesuré), et donne le solde au passage — une tâche qui échouerait en
`402 INSUFFICIENT_BALANCE` vaut mieux d'être annoncée au test que découverte au
milieu d'une délégation. Chez OpenAI, `/models` exige déjà la clé : aucune sonde
supplémentaire. Toujours aucun jeton facturé par un test.

---

## Ce qui est prouvé

| Suite | Contenu | Résultat |
|---|---|---|
| `npm run test:unit` | 126 tests : machine à états, persistance, configuration, **normalisation des deux adaptateurs**, **coûts**, **sécurité des outils**, **boucle d'agent** | 126/126, ~1 s |
| `npm run test:lock` | 8 daemons lancés ensemble, 10 manches | 10/10, ~30 s |
| `npm run test:restart` | 7 scénarios sur de vrais processus et de vraies sockets | 7/7, ~45 s |
| `npm run test:wait` | 12 scénarios de bout en bout, client MCP officiel | 12/12, ~178 s |
| `npm run test:live` | 5 scénarios **contre la vraie API Venice** — opt-in, s'abstient sans clé | 5/5, ~3 min, **0,0033 $** |

### Ce que les nouveaux tests verrouillent

**Le budget arrête la tâche avant l'appel de trop.** Trois appels à 0,40 $ sous
un budget de 1 $ : on vérifie qu'il n'y a **pas de quatrième appel**, et que le
statut est `budget_exceeded` et non `failed`. Sans faux fournisseur, ce test
coûterait de l'argent à chaque exécution ; avec, il tourne en millisecondes.

**La sécurité des chemins.** Remontée par `..`, lien symbolique sortant, chemin
absolu hors racine, lien de dossier sortant pendant une recherche — tous
refusés. Et le refus ne révèle pas où menait le lien.

**La revérification à chaque saut de redirection**, testée comme **invariant**
plutôt que par son effet : une suite hors ligne ne peut pas partir d'un vrai
hôte public, et constater un refus au premier saut ne prouverait rien sur les
suivants. La garde est donc injectée et l'on vérifie qu'elle est appelée pour
les deux hôtes, dans l'ordre. C'est la consigne de `CLAUDE.md` — tester les
invariants directement, pas leurs effets visibles.

**Le piège de coût de Gemini** : `thoughtsTokenCount` n'est pas compris dans
`candidatesTokenCount` alors que Google le facture au tarif de sortie.
Additionner naïvement sous-estime la facture d'un modèle de raisonnement.

**La dégradation de la provenance d'un coût** : un total qui mélange un appel
facturé et un appel estimé n'est pas une facture ; un seul tarif manquant rend
le total inconnu, et non partiellement juste.

---

## Essai réel

**Date :** 2026-10-29 · **Fournisseur :** Venice.ai · **Modèle :**
`deepseek-v4-flash-0731` (0,13 / 0,26 $ le million de jetons).

Une suite dédiée, **opt-in**, le rejoue : `npm run test:live`. Elle ne tourne
que si une clé est déjà déposée dans le coffre, et **s'abstient** sinon — une
absence de clé n'est pas un défaut du code. Elle est séparée de `npm test`
parce qu'elle ne peut être ni gratuite, ni hors ligne, ni tout à fait
reproductible, alors que les autres doivent être les trois.

| # | Scénario | Résultat |
|---|---|---|
| L1 | Le Researcher est annoncé disponible, et il l'est | 6 outils, clé acceptée, 141 modèles |
| L2 | Une vraie tâche aboutit à un résultat structuré | 2 appels modèle, 0,001699 $ |
| L3 | **Le coût affiché correspond au solde débité** | 0,003307 $ comptés, 0,003307 $ débités — **0,0 % d'écart** |
| L4 | Un budget volontairement bas arrête la tâche | `budget_exceeded` après **1 seul** appel modèle |
| L5 | Ce qui revient du web remonte encadré, avec ses sources | 2 sources, encadrement `<untrusted_data nonce=…>` présent |

### Le livrable, mesuré deux fois

Le solde Venice est relevé **chez le fournisseur** avant et après, et comparé à
ce que le harness a compté. C'est la seule vérification qui vaille : un tableau
de tarifs peut mentir, un solde non.

| | Compté par le harness | Débité par Venice | Écart |
|---|---|---|---|
| Suite `test:live`, 3 tâches | 0,003307 $ | 0,003307 $ | **0,0 %** |
| Tâche isolée, dossier runtime réel | 0,002412 $ | 0,002412 $ | **0,0 %** |

Exact au microdollar, deux fois. C'est possible parce que Venice annonce
`cost.usd` sur chaque réponse et qu'on retient **son** chiffre : on ne calcule
pas la facture, on la recopie.

Une **troisième** mesure, prise dans les mêmes conditions pendant l'essai en
vraie session, donne le même résultat : 0,00075362 $ débités pour 0,00075362 $
comptés.

### Ce qu'une vraie tâche donne

La tâche jouée dans le dossier runtime réel, pour qu'elle soit consultable dans
le dashboard :

> *Quels invariants le dépôt Midgaard déclare-t-il « à ne pas casser », et lequel
> a été appris en mesurant une coupure de client MCP à 60 secondes ?*

```text
statut       completed · 54,9 s · 2 appels modèle
jetons       18 002 entrée (dont 4 864 de cache) · 2 184 sortie (dont 707 de raisonnement)
coût         0,002412 $ — facturé par le fournisseur

étape 1   read_file   CLAUDE.md         8 ms   10 875 octets
étape 1   read_file   docs/SLICE0.md    1 ms   16 342 octets
étape 1   read_file   docs/SLICE1.md    1 ms   14 813 octets
étape 2   submit_result                        confiance : high
```

Réponse rendue : « Le dépôt déclare 19 invariants « à ne pas casser » dans
`CLAUDE.md` ; celui appris en mesurant une coupure de client MCP à 60 secondes
est « Notifications de progression pendant toute attente longue ». » — exact.

Trois choses se lisent dans ces quatre lignes :

1. **Le contexte fourni par Claude fait son travail.** L'agent n'a pas exploré
   le dépôt : il a lu les trois fichiers qu'on lui avait nommés, et rien d'autre.
   Deux appels modèle au total. C'est précisément l'économie que le §4 du plan
   visait — sans elle, déléguer coûte plus cher que faire soi-même.
2. **Les appels d'outils partent en parallèle**, trois d'un coup à la même
   itération, comme la limite `max_tool_calls_per_step` l'autorise.
3. **La fin est un acte** : `submit_result` à l'étape 2, pas une interprétation
   de texte libre.

### L'estimation locale est systématiquement haute, et on sait pourquoi

Sur cette tâche : **0,002908 $ estimés** contre **0,002412 $ facturés**, soit
+20,6 %. Ce n'est pas du bruit, c'est le cache.

Venice sert 4 864 des 18 002 jetons d'entrée depuis son cache, à tarif réduit —
mais `GET /models` **ne publie pas** ce tarif réduit, et la documentation des
prix l'omet également. Notre table facture donc les jetons de cache au tarif
plein, faute de mieux. Inventer un rabais plausible serait pire : le chiffre
retenu reste celui du fournisseur, et l'estimation ne sert que de témoin.

**C'est exactement ce que les deux montants côte à côte servent à révéler.**
Sans eux, l'écart serait invisible — et sur un fournisseur qui n'annonce aucun
coût (OpenAI, Gemini), c'est l'estimation haute qui serait affichée comme une
facture.

### Deux bogues du test, pas du produit

Le premier essai a donné 2 échecs sur 5. Les deux venaient de la suite :

1. **Une attente de 60 s tombe pile sur la coupure du client.** Le client du SDK
   n'envoie aucun jeton de progression, donc le serveur ne peut pas le tenir
   éveillé — c'est précisément ce que mesure le scénario S5 de `test:wait`, et
   la suite réelle est tombée dedans. Ramené à 25 s par tranche. Claude, lui,
   fournit un jeton et peut demander 300 s sans risque.
2. **Cumuler le coût scénario par scénario était faux.** Une tâche dont
   l'attente échoue **continue de tourner** côté daemon, et de dépenser. Son
   coût manquait au total, et l'écart de 47,6 % accusait le comptage pour une
   erreur du test. Le total vient désormais du registre du daemon, qui est de
   toute façon la source de vérité.

Le second est intéressant au-delà du test : il rappelle qu'**interrompre une
attente n'arrête pas une tâche** — ce que le scénario S4 garantit depuis la
Slice 0, et qu'il faut avoir en tête quand on compte de l'argent.

### Un défaut d'affichage, corrigé au passage

`budget de 0,0000 $ atteint` pour un budget de 0,000001 $ : quatre décimales
effaçaient un montant non nul, et le message ressemblait à un bogue. Le
formatage descend maintenant jusqu'à huit décimales quand il le faut.

### Ce que cet essai ne pouvait pas dire

Cet essai emploie le **client officiel du SDK**, le même protocole que Claude
Code, dans de vrais processus. Il ne remplace pas un essai dans une vraie
session : le client du SDK n'a ni les mêmes délais ni les mêmes habitudes, et
c'est ce constat qui a produit les deux défauts majeurs des Slices 0 et 1.

Les quatre questions qu'il laissait ouvertes — `context` spontané,
`harness_list_agents` avant la délégation, limites abaissées d'office, effet de
l'encadrement `<untrusted_data>` sur le rapport — ont été posées à une vraie
session le jour même : voir **[Essai en vraie session Claude Code](#essai-en-vraie-session-claude-code)**
ci-dessous, qui y répond et rapporte quatre défauts d'ergonomie.

---

## Essai en vraie session Claude Code

**Date :** 2026-10-29 · **Client :** `claude-code` **2.1.309**, app desktop ·
**Modèle orchestrateur :** Claude Opus 5 · **Coût total de l'essai :** 0,020434 $.
Sources : `~/.midgaard/mcp-trace.jsonl`, la base, et le dashboard.

C'est l'essai que le § « Ce que cet essai ne pouvait pas dire » appelait : non
plus le client
officiel du SDK, mais Claude Code lui-même, avec ses délais et ses habitudes.
**Il a trouvé quatre défauts d'ergonomie**, dont un faux négatif d'outil et un
message d'erreur qui envoie vers un réglage hors d'atteinte. Aucun n'était
visible depuis le client du SDK, parce qu'aucun ne se déclenche sans un modèle
qui se trompe de bonne foi.

### Chronologie (UTC)

| Heure | Événement |
|---|---|
| 06:24:44 | Ouverture de session ; capacités du client enregistrées — `elicitation`, `roots`, `extensions`, `supports_native_tasks: false` |
| 06:25:4x | `harness_list_agents` appelé **avant** toute délégation ; `simulated` et `researcher` annoncés actifs |
| 06:25:52 | Délégation n° 1 au `researcher`, `max_cost_usd` 0,02 **et `max_steps` 6 de ma propre initiative** |
| 06:25:58 | Attente n° 1, `timeout_s` **180 choisi par Claude** |
| 06:27:00 | **Échec** : 62,57 s d'attente, 4 notifications, aucune coupure. L'agent a épuisé les 6 étapes sans `submit_result` — **0,006264 $ pour rien** |
| 06:28:46 | Délégation n° 1 bis : plafond d'étapes retiré, et mise en garde sur `search_files` ajoutée au `context` |
| 06:29:09 | Résultat en **2 appels modèle**, 20,76 s, 1 notification, 0,001785 $ — réponse vérifiée exacte contre le code |
| 06:30:03 | Délégation n° 2, question exigeant le web, `max_cost_usd` 0,05 (choisi pour couvrir les 0,01 $ de la recherche) |
| 06:30:47 | Résultat avec **7 citations** et encadrement `<untrusted_data nonce="d83616a7…">`, 40,88 s, 2 notifications, 0,011632 $ |
| 06:32:03 | Tâche `simulated` de 25 s, gratuite, pour voir le dashboard bouger sans payer |
| 06:33:30 | Mesure propre solde avant / après sur une tâche de 0,00075362 $ |

### Ce qui est confirmé

| Question | Réponse |
|---|---|
| L'attente tient-elle au-delà de 60 s **dans le vrai client** ? | **Oui** : 62,57 s en un seul appel, 4 notifications, aucune coupure. C'est la première mesure de cet invariant hors du client du SDK |
| Claude appelle-t-il `harness_list_agents` avant de déléguer ? | **Oui**, systématiquement — mais voir la réserve ci-dessous : le mérite en revient au serveur |
| Le `context` évite-t-il la redécouverte ? | **Oui, et c'est mesurable** : 3 `read_file` sur les 3 fichiers nommés, **zéro** lecture de `CLAUDE.md` ou de `docs/SLICE2.md`, dont le contenu utile était passé en `context` |
| Claude suit-il `next_action` ? | **Oui** : une attente par délégation, jamais de sondage par `harness_get_task_status` |
| Le coût affiché est-il la facture ? | **Oui, remesuré ici** : 0,00075362 $ débités chez Venice, **0,00075362 $ comptés** — 0,0 % d'écart, une troisième fois |
| Le web revient-il encadré et sourcé ? | **Oui** : `<untrusted_data nonce=…>` avec préambule, 7 citations `{title, url}`, et un `note` qui redit la consigne |
| `roots` sert-elle vraiment ? | **Oui** : le dashboard affiche « Racine de lecture : /Users/andydodakal/Documents/Midgaard », que le client a déclarée |
| Le dashboard bouge-t-il en direct ? | **Oui** : étape 1/5 → 2/5 → 4/5 sans rechargement, par WebSocket ; coûts, 9 appels d'outils avec leurs arguments, et sources s'affichent |
| Les « Tasks » MCP natives sont-elles rouvertes ? | **Non** : `supports_native_tasks: false` en 2.1.309, inchangé. `harness_wait_for_task` reste nécessaire |

### Ce qui n'est pas confirmé

| | |
|---|---|
| Que Claude appelle `harness_list_agents` **spontanément** | Les `instructions` du serveur le lui ordonnent en toutes lettres, et la description de `harness_delegate_task` le répète. L'essai prouve que la consigne est suivie, pas qu'elle serait superflue |
| Que Claude passe un `context` utile **de lui-même** | Même réserve : la consigne est explicite aux deux endroits. Ce que l'essai prouve, c'est que la consigne **fonctionne** — ce qui est la question utile, puisque la consigne, elle, est acquise |
| Qu'un plafond d'étapes bas soit sans danger | Démenti : voir le défaut n° 2 |
| Le comportement sous approbation humaine | Non exercé ici : aucun outil du `researcher` ne demande d'approbation. C'était l'objet de l'essai de la Slice 1 |

### Ce que l'encadrement `<untrusted_data>` a changé

**Il a changé le rapport, et de façon vérifiable.** La réponse web tranchait une
dette ouverte de cette slice — le grounding `google_search` de Gemini — et la
tentation était de l'inscrire ici comme un fait établi. L'encadrement l'a
interdit : ce qui remonte est **ce qu'un agent a lu sur des pages**, pas ce que
le dépôt a constaté. La dette n° 2 est donc mise à jour plus bas en **attribuant
la source**, et elle reste ouverte jusqu'à un appel réel.

Le préambule porte aussi l'instruction de ne pas obéir au contenu encadré. Rien
dans ce que l'agent a rapporté n'essayait de donner un ordre, donc cette
protection-là n'a pas été éprouvée ; seule l'attribution l'a été.

### Les quatre défauts d'ergonomie

Le premier est corrigé ; les trois autres sont consignés pour que l'auteur
tranche.

#### 1. `search_files` répond « 0 correspondance » au lieu d'une erreur

Le plus grave, parce que c'est un **faux négatif qui a l'air d'une vraie
réponse**. L'agent a cherché `checkLimits` en passant un **fichier** dans `path` :

```text
search_files {"pattern":"checkLimits","path":"packages/agent-runtime/src/loop.ts"}
  -> succeeded | 0 correspondance(s) dans 0 fichier(s)
```

`checkLimits` existe pourtant à `loop.ts:186` et `budget.ts:43`. Le schéma dit
bien « Directory to search in » — l'agent a mal employé l'outil. Mais l'outil
répond à un mauvais emploi par un chiffre faux et confiant, au lieu d'une
erreur. Cause exacte : `packages/tools/src/fs.ts:164` fait
`readdir(dir).catch(() => [])` ; sur un fichier, `readdir` lève `ENOTDIR`
(reproduit directement), le `catch` l'avale, la marche est vide et le résultat
devient « (aucune correspondance) » — indistinguable d'une vraie absence.

L'agent a cru la réponse, a reformulé quatre fois, et a brûlé son budget
d'étapes. **C'est la cause première de l'échec de la délégation n° 1.** Un
`ENOTDIR` remonté en `ToolError` l'aurait corrigé au premier essai.

Seconde lecture possible : le résumé « 0 correspondance(s) dans **0** fichier(s) »
disait la vérité — zéro fichier parcouru — mais personne ne lit « 0 fichier »
comme « ton chemin n'est pas un répertoire ».

**Corrigé.** `search_files` vérifie désormais que la racine de la recherche est
un répertoire et refuse sinon, en disant quoi faire :

```text
search_files searches a directory, and "packages/agent-runtime/src/loop.ts" is
not one. Search "packages/agent-runtime/src" instead and narrow with glob, or
read the file with read_file.
```

L'appel exact qui avait menti pendant l'essai a été rejoué contre le dépôt :
il refuse, et le répertoire qu'il propose rend les 5 occurrences réelles de
`checkLimits`, `loop.ts:186` comprise. La tolérance reste où elle a un sens —
un sous-dossier illisible n'interrompt toujours pas une recherche.

Un refus ne coûte pas la tâche, et c'est ce qui rend le correctif sûr : la
boucle rattrape une `ToolError` et la rend au modèle en `Failed: …`
(`loop.ts:463-468`), en la journalisant comme appel échoué. Le modèle lit donc
le message, apprend qu'il s'est trompé de forme, et corrige au tour suivant —
là où il croyait auparavant un zéro et s'entêtait. Échanger un faux négatif
contre une erreur dure aurait été un mauvais marché ; ce n'est pas ce qui se
passe.

Deux tests le verrouillent, et le second compte autant que le premier : il
vérifie que le motif **existe** quand on cherche comme il faut. Sans lui, le
test du refus passerait aussi pour un motif simplement absent. Retirer la garde
fait bien échouer le premier et seulement lui — vérifié.

#### 2. Le motif d'échec ne nomme pas la cause, et le conseil vise un réglage hors d'atteinte

La délégation n° 1 a rendu ceci :

```text
status  failed · step 6/5
error   l'agent s'est arrêté sans appeler submit_result, même après relance
        — aucun résultat structuré à remonter
hint    The task ended without a result. Do not retry automatically; tell the user.
```

La vraie cause était **le `max_steps: 6` que j'avais posé moi-même**, et le
message ne le dit nulle part. Le seul conseil actionnable est une note
d'exécution, visible seulement dans le dashboard ou la base :

> `réponse coupée à 4096 jetons de sortie ; relève max_output_tokens si cela se répète`

Or `max_output_tokens` **n'est pas un paramètre de `harness_delegate_task`** —
le schéma n'expose que `max_cost_usd`, `max_steps` et `timeout_s`. Et même
exposé, `tightenLimits` (`packages/contracts/src/agent.ts:105`) ne sait
qu'**abaisser** : « relever » est impossible par construction depuis une
délégation. Le conseil s'adresse donc à qui édite
`packages/daemon/src/agents.ts`, pas à qui lit le message.

Pour le lecteur du message, le conseil utile serait : *raccourcis l'objectif, ou
relève `max_steps`*. J'ai dû le deviner. La reprise a marché du premier coup —
mais parce que je savais lire la base, ce qu'un utilisateur ne fera pas.

À noter au crédit du harness : **`hint` dit explicitement de ne pas réessayer
tout seul et de prévenir l'utilisateur.** C'est exactement la bonne consigne, et
elle m'a retenu de relancer en boucle une tâche qui coûtait de l'argent.

#### 3. `step` affiche un dénominateur qui ne veut rien dire pour un agent réel

`step: "6/5"` pour une tâche plafonnée à **6** étapes ; `"2/5"` et `"1/5"` pour
des tâches plafonnées à **12**. Le dénominateur est `steps_total`, que
`packages/daemon/src/task-manager.ts:195` remplit avec la constante
`STEPS_TOTAL` **de l'exécutant simulé**, pour toutes les tâches. La vraie limite
est `max_steps`, qui vit dans `limits_json`.

Le défaut traverse les trois interfaces : MCP (`packages/mcp-server/src/server.ts:217`),
CLI (`packages/cli/src/commands.ts:145`) et dashboard (« étape 6 sur 5 »). Il
est cosmétique, mais il ment au seul endroit où l'on cherche à savoir si une
tâche a touché son plafond — et « 6/5 » m'a d'abord fait croire à un dépassement
d'un cran, pas à ma propre limite atteinte.

#### 4. L'écart de coût accuse la table de tarifs quand la cause est le cache

Sur la tâche échouée, le dashboard affiche :

> Notre estimation : 0,0098 $. **Écart de 36 % : les tarifs locaux ont probablement vieilli.**

C'est faux, et cette slice le sait déjà : la tâche a lu **34,8 k jetons de cache
sur 58,3 k d'entrée**, et le § « L'estimation locale est systématiquement haute »
explique que Venice ne publie pas son tarif de cache. La table n'a pas vieilli —
elle a été relevée chez le fournisseur le jour même. Le message envoie vers
`harness pricing refresh venice`, qui ne changerait rien.

`apps/dashboard/src/components/UsageCard.tsx:97` ne connaît qu'une cause
possible à un écart. Il en existe une seconde, documentée, et que le nombre de
jetons de cache suffirait à distinguer.

#### Et un cinquième, mineur, dans le même esprit

`formatCost` (`apps/dashboard/src/lib/utils.ts:54`) passe à **deux** décimales
au-dessus de 0,01 $. La tâche web facturée 0,011632 $ et estimée 0,011763 $
s'affiche donc « 0,01 $ » **des deux côtés**. La phrase « Les deux concordent »
reste exacte — elle compare les vraies valeurs avec un seuil de 20 % — mais les
deux chiffres dont tout le § « Le coût cesse d'être une promesse » dit qu'ils
n'ont de valeur **que côte à côte** deviennent identiques à l'œil, pile dans la
tranche où vit une vraie tâche. C'est le défaut « budget de 0,0000 $ » déjà
corrigé plus haut, à l'autre bout de l'échelle.

### Ce que l'essai apprend sur le comportement de Claude

**Le `context` fonctionne, et son effet se mesure.** Les deux délégations sur le
dépôt ont lu exactement les fichiers nommés, et rien d'autre. Mieux : la seconde
portait un **avertissement sur un outil** — « `search_files` n'accepte qu'un
répertoire » — et l'agent a cessé de s'y casser les dents. Le `context` ne sert
donc pas qu'à transmettre des faits : il transmet aussi les pièges connus.

**Abaisser une limite n'est pas gratuit.** J'ai abaissé `max_cost_usd` parce
qu'on me l'avait demandé, mais `max_steps: 6` était mon initiative, sur le
raisonnement « une lecture de trois fichiers tient en six étapes ». Il en aurait
fallu six à un agent qui ne se heurtait pas au défaut n° 1 — et la marge a
disparu au premier outil qui mentait. **La limite d'étapes est celle dont le bon
réglage dépend d'un aléa qu'on ne contrôle pas**, contrairement au budget et au
délai, qui ont le bon goût d'être continus. Le plafond coûte alors plus cher
qu'il ne protège : 0,006264 $ perdus pour économiser 0,002 $.

**Le délai, lui, se choisit sans risque.** 180 s, 180 s, 240 s, 120 s selon ce
que j'attendais — jamais la valeur par défaut sans y penser, et jamais de
coupure. Interrompre une attente n'arrête pas la tâche : le coût est donc nul.

### Conséquence pour les dettes de la Slice 3

La délégation n° 2 a rapporté, **sur la foi de pages web citées et non d'un
appel réel**, que la documentation de Google énonce que `googleSearch` ne peut
pas être combiné avec des `functionDeclarations` dans la même requête
`generateContent`, et que l'« Interactions API » est recommandée pour les
nouveaux développements tandis que `generateContent`, étiqueté *legacy*, reste
recommandé pour la production stable.

Si cela se confirme, la dette n° 2 (« rouvrir le grounding ») ne se règle pas
par un essai mais par un **choix d'architecture** : deux appels, ou l'Interactions
API. Elle reste ouverte — rien ici n'a été constaté contre l'API réelle, et
c'est précisément la discipline que l'encadrement `<untrusted_data>` impose.

---

## Limites connues

- **Trois défauts d'ergonomie ouverts**, trouvés en vraie session et **non
  corrigés** : un échec par plafond d'étapes ne nomme pas sa cause et conseille
  un réglage hors d'atteinte ; `step` affiche le dénominateur de l'exécutant
  simulé (« 6/5 ») ; un écart de coût dû au cache est imputé à la table de
  tarifs. Détail et emplacements au § « Essai en vraie session Claude Code ».
  Le quatrième — `search_files` qui rendait « 0 correspondance » sur un chemin
  de fichier — est corrigé.
- **L'approbation humaine n'a pas été rejouée en Slice 2.** Aucun outil du
  `researcher` n'en demande — c'est en lecture seule. Ce chemin a été vérifié
  en Slice 1, et le sera de nouveau en Slice 3 avec les outils d'écriture.
- **L'estimation locale est haute de ~20 % sur un modèle qui sert du cache**,
  parce que Venice ne publie pas son tarif de cache. Sans conséquence tant que
  le fournisseur annonce son propre coût ; à garder en tête pour OpenAI et
  Gemini, qui ne l'annoncent pas.
- **L'adaptateur Gemini n'a jamais été exécuté contre l'API réelle.** Écrit
  d'après la documentation REST, vérifié sur réponses enregistrées. À
  reconfirmer avec une clé. Au passage, la documentation de Google recommande
  désormais une « Interactions API » pour les nouveaux projets et qualifie
  `generateContent` de *legacy* tout en le maintenant : à réévaluer en même temps.
- **Le grounding `google_search` de Gemini n'est pas activé.** Il partage le
  tableau `tools` avec les `functionDeclarations`. Le Researcher a besoin de ses
  fonctions — sans `submit_result`, aucune tâche ne peut finir. Le crochet est
  écrit, il n'est pas franchi. **Une recherche web déléguée le 2026-10-29
  rapporte, sur la foi de pages de documentation Google citées, que les deux ne
  peuvent pas cohabiter dans une même requête `generateContent`** — ce qui
  changerait la dette d'un essai en un choix d'architecture (deux appels, ou
  l'« Interactions API »). Rien n'a été constaté contre l'API réelle : c'est
  un rapport encadré en `<untrusted_data>`, pas une mesure, et la dette reste
  ouverte.
- **Windows et Linux ne sont pas vérifiés automatiquement** pour le coffre. La
  suite exerce le repli fichier partout et le trousseau macOS sur macOS ; DPAPI
  et libsecret sont écrits d'après leurs documentations et restent à éprouver sur
  machine réelle.
- **Le DNS rebinding reste théoriquement possible** sur `http_fetch` : on vérifie
  toutes les adresses résolues, puis `fetch` résout une seconde fois.
- **`pricing.json` livré ne contient que des tarifs Venice**, relevés à la main
  le 2026-10-29. OpenAI et Gemini en sont **volontairement absents** : inventer
  un tarif serait pire que de l'ignorer, et le harness affiche alors « tarif
  inconnu ». `harness pricing refresh venice` remplace le relevé manuel.
- **Pas de test Playwright du dashboard.** Reporté une seconde fois, en Slice 3,
  quand l'interface portera des diffs.
- **Pas de projets, pas de worktrees, pas d'écriture.** C'est la Slice 3.

---

## Ce qui attend la Slice 3

Le plan prévoyait déjà `workspace`, les outils d'écriture et l'UI d'approbation
bloquante. S'y ajoutent quatre choses nées de cette slice :

1. **Éprouver Gemini contre l'API réelle**, et trancher `generateContent` contre
   l'Interactions API.
2. **Rouvrir le grounding `google_search`** une fois une clé disponible. La
   question a changé de nature : une recherche web rapporte que la documentation
   de Google **interdit** la cohabitation avec les `functionDeclarations` (voir
   § « Limites connues »). À confirmer par un appel réel, puis à trancher — deux
   appels, ou l'Interactions API.
3. **Vérifier le coffre sur Windows et Linux.** DPAPI et libsecret sont écrits,
   pas constatés.
4. **Trancher les trois défauts d'ergonomie restants**, listés au § « Les quatre
   défauts d'ergonomie ». Le quatrième, `search_files`, est corrigé — c'était
   le seul à faire perdre de l'argent à chaque agent qui s'y fiait. Les trois
   autres trompent le lecteur sans lui coûter : un message d'échec qui tait sa
   cause, un dénominateur emprunté à l'exécutant simulé, un écart de coût mal
   imputé.
