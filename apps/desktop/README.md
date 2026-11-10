# Coque desktop

Une fenêtre Tauri 2 autour du dashboard (Slice 6, étape 7). Elle ne contient
**aucune logique du harness** : elle démarre le daemon, ou s'y rattache, par
la CLI du clone, lit l'adresse du dashboard dans son fichier de découverte, et
ouvre une fenêtre dessus. Le même dashboard s'ouvre toujours dans un navigateur.

```bash
npm run desktop:build    # une fois, et après chaque mise à jour du clone (Rust requis)
npm run desktop          # ouvre la fenêtre ; démarre le daemon au besoin
```

Construite **localement**, depuis le clone : rien n'est distribué (décision
du 2026-11-01), donc ni signature ni notarisation. Le binaire est dans
`src-tauri/target/release/`.

## Une application à lancer d'un double-clic

```bash
npm run build            # le dashboard que le daemon sert
npm run desktop:bundle   # .dmg sous macOS, installeur .exe (NSIS) sous Windows
```

Le paquet est déposé dans `src-tauri/target/release/bundle/` (`dmg/` ou
`nsis/`), et la commande affiche son chemin. Sous macOS : ouvrir le `.dmg`,
glisser Midgaard dans Applications.

**Ce n'est pas une distribution.** L'application emballée est la même coque :
elle ne contient ni Node, ni le daemon, ni le dashboard, et démarre le daemon
par la CLI de **ce clone**, avec le `node` gravé au build (voir plus bas).
Copiée sur une autre machine, ou après un déplacement du clone, elle ne
démarre rien ; après une mise à jour du clone ou de Node, relancer
`desktop:bundle`. Non signée : sur la machine qui l'a construite, macOS
l'ouvre sans avertissement ; ailleurs, Gatekeeper la refuserait.

Lancée d'un double-clic, elle n'a pas de console : si le daemon ne démarre
pas, rien ne s'affiche. `npm run desktop` montre l'erreur.

L'emballage passe par la CLI de Tauri (`@tauri-apps/cli`, dépendance de
développement), lancée par `bundle.ts` avec `tauri.bundle.conf.json`, qui
recouvre `bundle.active`. La configuration de base le garde à `false` :
`desktop:build` (cargo seul) ne change pas.

Constaté sous macOS (arm64) : le `.dmg` monté, l'application démarre le daemon
sans le `PATH` du terminal et ouvre le dashboard. **L'installeur Windows n'a
pas encore été construit** ; Linux n'est pas proposé.

## Ce qu'elle garantit

- **La page n'a aucune capacité Tauri** (`app.security.capabilities: []`,
  aucun plugin) : le dashboard ne parle qu'au daemon, en HTTP, comme dans un
  navigateur.
- **L'origine ne change pas.** La fenêtre charge `http://127.0.0.1:<port>/`,
  l'origine que le daemon accepte déjà : ses contrôles `Host`, `Origin` et
  `Sec-Fetch-Site` restent ceux du navigateur. Une page embarquée
  (`tauri://localhost`) aurait demandé d'ouvrir la liste blanche des origines.
- **Elle ne navigue que sur le dashboard** (`on_navigation`) : ni lien ni
  redirection ne mène ailleurs. Un fichier déposé sur la fenêtre est
  intercepté par le gestionnaire de Tauri, gardé exprès : sans IPC, il n'a
  aucun effet. Et l'adresse
  lue dans `daemon.json` doit être sur la boucle locale, sans quoi la fenêtre
  ne s'ouvre pas.
- **Elle n'utilise pas le jeton** de `daemon.json` : elle n'en retient que
  `dashboard_url`, et le jeton n'est ni copié ni passé à la fenêtre. Le
  dashboard obtient le sien par `/ui/bootstrap`, comme ailleurs.
- **Elle n'arrête pas le daemon** en se fermant : il s'arrête de lui-même
  après son délai d'inactivité.

## Trouver `node` sans le `PATH` du shell

Une application ouverte d'un double-clic n'hérite pas du `PATH` du terminal, et
ne trouverait pas `node`. `build.rs` grave donc dans le binaire le chemin du
`node` de npm (`npm_node_execpath`) et la racine du clone. Au lancement,
`MIDGAARD_NODE` et `MIDGAARD_REPO` passent devant : c'est ce que fait
`npm run desktop`, qui transmet aussi `--home` par `MIDGAARD_HOME`. Changer de
version de Node, ou déplacer le clone, demande de reconstruire.

## Fichiers

| Fichier | Rôle |
|---|---|
| `src-tauri/src/main.rs` | Démarrage du daemon, lecture de l'adresse, fenêtre |
| `src-tauri/build.rs` | Contexte Tauri, chemin de `node` et racine du clone gravés |
| `src-tauri/tauri.conf.json` | Aucune fenêtre ni capacité déclarée : la fenêtre est créée par le code |
| `src-tauri/tauri.bundle.conf.json` | Active l'emballage, pour `desktop:bundle` seulement |
| `bundle.ts` | `npm run desktop:bundle` : choisit le format, lance la CLI de Tauri, nomme le paquet produit |
| `src-tauri/icons/` | `icon.png`, et `icon.ico` qui le contient tel quel : Windows exige l'ICO pour la ressource de l'exécutable |
| `ui/index.html` | Dossier d'interface exigé par Tauri, jamais affiché |
| `packages/cli/src/desktop.ts` | `harness desktop`, le lanceur |
