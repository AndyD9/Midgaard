# `@midgaard/tests`

Six suites, de la plus rapide à la plus lente. Elles utilisent le lanceur
intégré à Node (`node --test`) et de vrais processus — aucun double, aucune
simulation de notre côté.

| Suite | Durée | Ce qu'elle protège |
|---|---|---|
| `npm run test:unit` | ~1 s | Machine à états (matrice complète), persistance, configuration, traversée de chemins, **coffres** |
| `npm run test:vault` | ~1 s | Les coffres seuls : conformité du coffre **réel de la machine**, plus le repli |
| `npm run test:lock` | ~30 s | Un seul daemon vivant, sous concurrence |
| `npm run test:restart` | ~45 s | Redémarrage, reprise WebSocket, contrôles d'accès, expiration, inactivité |
| `npm run test:ui` | ~1 min | Le dashboard **rendu dans un navigateur** : direct, approbation, reconnexion |
| `npm run test:wait` | ~3 min | 12 scénarios de bout en bout avec le client MCP officiel |

`npm test` enchaîne `unit`, `lock`, `restart` et `wait`. Les deux autres ont
chacune un prérequis qui ne peut pas être supposé, et se lancent à part.

## Les deux suites à prérequis

**`test:ui`** demande le dashboard compilé (`npm run build`) et le navigateur de
Playwright, que `npm ci` ne télécharge pas :

```
npx playwright install chromium
```

La suite vérifie les deux avant son premier scénario et dit la commande exacte
qui manque, plutôt que d'échouer sur une erreur de bibliothèque.

**`test:vault`** éprouve le coffre système **de la machine qui l'exécute** : le
trousseau macOS sur un Mac, DPAPI sous Windows, libsecret sous Linux de bureau.
Elle n'écrit jamais sous une référence réelle — toutes les siennes commencent par
`test.conformance.<pid>.` — et nettoie derrière elle.

Comme une machine n'en prouve qu'un, `.github/workflows/vault.yml` la lance sur
quatre postes : macOS, Windows, Linux avec trousseau, et Linux **sans**. Chaque
poste pose `MIDGAARD_REQUIRE_VAULT`, et la suite échoue si ce n'est pas ce
coffre-là qui a été retenu — sans quoi un poste sans trousseau sauterait la
batterie et passerait au vert sans rien avoir éprouvé.

## Deux principes

**Tester l'invariant, pas son symptôme.** En Slice 0, un test vérifiait que deux
clients voyaient le même daemon — ce qui reste vrai même quand deux daemons
tournent, puisque les clients lisent le même fichier de découverte. Deux daemons
orphelins ont survécu à une suite entièrement verte. `single-instance.ts` compte
donc les **processus vivants**.

**Vérifier ce qu'on annonce.** Le scénario S8 ne se contente plus de vérifier que
la consigne d'approbation ne mentionne pas un dashboard inexistant : quand une URL
est annoncée, il la **charge** et vérifie qu'elle sert vraiment le dashboard.

## Isolation

Chaque suite travaille dans un `MIDGAARD_HOME` temporaire et sur le port 0, choisi
par le système. Aucune ne touche au daemon de développement (`~/.midgaard`), et
deux suites peuvent tourner en même temps.

Une exception, et elle est inévitable : **`test:vault` écrit dans le trousseau de
l'utilisateur**, parce que le coffre système est par utilisateur et qu'aucune
variable ne le déplace. C'est précisément pour cela qu'il a si longtemps échappé
aux tests. L'isolation se fait donc par la **référence** : chaque exécution tire
un préfixe `test.conformance.<pid>.<aléa>`, et supprime ce qu'elle a déposé même
quand un cas échoue. Les autres suites, elles, continuent de poser
`MIDGAARD_VAULT=file` : écrire `provider.venice` depuis un test écraserait la
vraie clé de l'utilisateur, sous la même référence, sans rien dire.

## Ce qui n'est pas ici

- **Le rendu visuel.** `test:ui` vérifie des comportements — un texte attendu, un
  clic qui débloque, un badge qui change — pas des pixels. Il n'y a pas de
  capture de référence, et c'est volontaire : une régression visuelle coûte moins
  cher qu'une suite qui rougit à chaque retouche de style.
- **L'adaptateur Gemini contre l'API réelle**, faute de clé. Les réponses
  enregistrées le couvrent, l'API ne le confirme pas.
- **La vraie session Claude Code.** Le client du SDK n'a ni les mêmes délais ni les
  mêmes habitudes que le client réel : c'est le serveur MCP qui l'observe, dans
  `~/.midgaard/mcp-trace.jsonl`.
