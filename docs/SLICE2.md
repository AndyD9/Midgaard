# Slice 2 — Agents réels

**Date :** 2026-10-29 · **Objectif :** faire tourner de **vrais** agents — des
fournisseurs derrière une interface commune, une boucle avec budgets et limites,
des outils de lecture contrôlés, un coffre pour les clés, et un coût qui
corresponde à la facture.

**État : livrable atteint, et mesuré.** Un Researcher exécute de vraies tâches
sur Venice, et **le coût affiché correspond au centime près au solde débité** —
vérifié deux fois, à 0,0 % d'écart, en relevant le solde chez le fournisseur
avant et après. 124 vérifications unitaires, 10 d'instance unique, 7
d'intégration, 12 de bout en bout MCP et 5 d'essai réel, 0 échec.

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
| `npm run test:unit` | 121 tests : machine à états, persistance, configuration, **normalisation des deux adaptateurs**, **coûts**, **sécurité des outils**, **boucle d'agent** | 121/121, ~1 s |
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

### Ce qui reste à faire en vraie session Claude Code

Cet essai emploie le **client officiel du SDK**, le même protocole que Claude
Code, dans de vrais processus. Il ne remplace pas un essai dans une vraie
session : le client du SDK n'a ni les mêmes délais ni les mêmes habitudes, et
c'est ce constat qui a produit les deux défauts majeurs des Slices 0 et 1.

Il faut pour cela **ouvrir une nouvelle session** — Claude Code ne relit
`.mcp.json` et ne relance son serveur MCP qu'à l'ouverture. Ce qu'il restera à
observer, et que seule une vraie session peut dire :

- Claude passe-t-il spontanément un `context` utile, ou laisse-t-il l'agent
  redécouvrir le dépôt ?
- Appelle-t-il `harness_list_agents` avant de déléguer, ou devine-t-il un
  `agent_id` ?
- Abaisse-t-il les limites de lui-même quand la tâche est petite ?
- L'encadrement `<untrusted_data>` change-t-il sa façon de rapporter ce que
  l'agent a trouvé sur le web ?

## Limites connues

- **Aucun essai dans une vraie session Claude Code.** L'essai réel passe par le
  client officiel du SDK, qui parle le même protocole mais n'a ni les mêmes
  délais ni les mêmes habitudes. Il faut ouvrir une **nouvelle** session pour
  cela — le serveur MCP n'est relu qu'à l'ouverture.
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
  tableau `tools` avec les `functionDeclarations`, et rien dans la documentation
  ne dit qu'ils cohabitent. Le Researcher a besoin de ses fonctions — sans
  `submit_result`, aucune tâche ne peut finir. Le crochet est écrit, il n'est pas
  franchi. Envoyer les deux au jugé risquerait un 400 à chaque itération, ou pire :
  un grounding silencieusement ignoré dont on facturerait quand même l'illusion.
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
bloquante. S'y ajoutent trois choses nées de cette slice :

1. **Éprouver Gemini contre l'API réelle**, et trancher `generateContent` contre
   l'Interactions API.
2. **Rouvrir le grounding `google_search`** une fois une clé disponible : la
   question « cohabite-t-il avec les `functionDeclarations` ? » se répond en un
   appel.
3. **Vérifier le coffre sur Windows et Linux.** DPAPI et libsecret sont écrits,
   pas constatés.
