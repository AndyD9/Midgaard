# `@midgaard/tests`

Quatre suites, de la plus rapide à la plus lente. Elles utilisent le lanceur
intégré à Node (`node --test`) et de vrais processus — aucun double, aucune
simulation de notre côté.

| Suite | Durée | Ce qu'elle protège |
|---|---|---|
| `npm run test:unit` | ~1 s | Machine à états (matrice complète), persistance, configuration, traversée de chemins |
| `npm run test:lock` | ~30 s | Un seul daemon vivant, sous concurrence |
| `npm run test:restart` | ~45 s | Redémarrage, reprise WebSocket, contrôles d'accès, expiration, inactivité |
| `npm run test:wait` | ~3 min | 12 scénarios de bout en bout avec le client MCP officiel |

`npm test` les enchaîne toutes.

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

## Ce qui n'est pas ici

- **Le dashboard**, vérifié à la main dans un navigateur. Playwright est reporté en
  Slice 3, quand l'interface portera des diffs.
- **La vraie session Claude Code.** Le client du SDK n'a ni les mêmes délais ni les
  mêmes habitudes que le client réel : c'est le serveur MCP qui l'observe, dans
  `~/.midgaard/mcp-trace.jsonl`.
