# Slice 2 — Agents réels

**Date :** 2026-10-29 · **Objectif :** faire tourner de **vrais** agents — des
fournisseurs derrière une interface commune, une boucle avec budgets et limites,
des outils de lecture contrôlés, un coffre pour les clés, et un coût qui
corresponde à la facture.

**État : code livré et éprouvé hors ligne, essai réel en attente d'une clé.**
121 vérifications unitaires, 7 scénarios d'intégration, 12 scénarios de bout en
bout MCP, 0 échec. Ce qui n'a pas encore eu lieu est dit tel quel au §
« Limites connues » — aucune ligne de ce document ne décrit quelque chose qui
n'existe pas.

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

## Essai en session réelle

> **À faire.** Cette section sera remplie quand une clé Venice aura été déposée
> et qu'un Researcher aura exécuté une vraie tâche depuis une session Claude
> Code. Elle n'est pas écrite d'avance : la Slice 0 et la Slice 1 ont toutes
> deux montré que l'essai réel apprend des choses que la suite de tests ne dit
> pas — le client du SDK n'a ni les mêmes délais ni les mêmes habitudes que le
> client réel.
>
> Ce qu'il faudra vérifier :
>
> - le coût affiché correspond-il au solde réellement débité chez Venice ?
> - Claude passe-t-il un `context` utile, ou l'agent réexplore-t-il le dépôt ?
> - la recherche web se déclenche-t-elle, et les citations remontent-elles ?
> - combien d'itérations avant `submit_result` ?
> - l'encadrement `<untrusted_data>` survit-il jusqu'à la réponse de Claude ?

---

## Limites connues

- **Aucun agent réel n'a encore tourné contre une vraie clé.** C'est la seule
  chose qui manque au livrable de cette slice.
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
