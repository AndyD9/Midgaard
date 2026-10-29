# `@midgaard/secrets`

Coffre système pour les clés d'API des fournisseurs de modèles, **sans
dépendance native**. La base du harness ne contient que des références
(`provider.venice`) ; les clés vivent ici.

## Ce que chaque plateforme offre réellement

| Plateforme | Mécanisme | Protégé par l'OS | Le secret passe par |
|---|---|---|---|
| macOS | `security` — trousseau | oui | argument (voir la limite ci-dessous) |
| Windows | PowerShell `ConvertFrom-SecureString` — DPAPI, lié au compte et à la machine | oui | entrée standard |
| Linux | `secret-tool` — libsecret, trousseau de session | oui | entrée standard |
| partout | repli fichier `0600` dans `~/.midgaard/secrets` | **non** | — |

`SecretVault.osBacked` porte cette colonne. Le repli existe pour les serveurs
sans session graphique ; il est annoncé comme ce qu'il est, pas présenté comme un
coffre.

## Pourquoi ces mécanismes et pas d'autres

**Pas de `keytar`.** C'est une dépendance native : binaire précompilé à
télécharger, compilation locale si la plateforme n'est pas couverte. La Slice 1 a
refusé `better-sqlite3` pour la même raison, et pour le même bénéfice : un
`git clone` suffit partout.

**Pas le Credential Manager de Windows.** `cmdkey`, seul utilitaire fourni
d'office, sait écrire un identifiant mais pas relire un mot de passe — c'est
délibéré de la part de Windows. Le module PowerShell `CredentialManager` le
permettrait, mais il n'est pas installé par défaut.

## Le coffre est par utilisateur, pas par dossier runtime

Le trousseau ne connaît qu'un **service** `midgaard` et un **compte**
`provider.<id>`. `MIDGAARD_HOME` déplace la base, le journal et le verrou ; il
ne déplace **pas** les clés. Deux installations qui emploient le même compte
utilisateur partagent donc leurs secrets — ce qui est voulu pour un humain, et
dangereux pour une suite de tests : écrire `provider.venice` depuis un test
écraserait la vraie clé, sous la même référence, sans rien dire.

Les tests forcent donc `MIDGAARD_VAULT=file` (voir `tests/helpers.ts`), ce qui
les cantonne à leur dossier jetable.

## Limites connues, et assumées

- **macOS expose le secret dans `ps` le temps de l'écriture.** `security
  add-generic-password` n'accepte le mot de passe qu'en argument (`-w`) ; il ne
  lit pas l'entrée standard. Seuls les processus du **même utilisateur** le
  voient — et ceux-là peuvent de toute façon lire le jeton du daemon dans
  `~/.midgaard/daemon.json`. C'est déjà hors du modèle de menace décrit dans
  [`packages/daemon/README.md`](../daemon/README.md). La **lecture** n'expose rien.
- **DPAPI protège contre le vol de fichier, pas contre la session compromise.**
  Tout processus tournant sous le même compte Windows peut déchiffrer. C'est
  également vrai du trousseau macOS sans demande de mot de passe.
- **Un trousseau déverrouillé est un trousseau ouvert.** Aucun des trois
  mécanismes ne redemande de mot de passe à chaque lecture : ils protègent le
  secret **au repos**, pas contre un processus déjà dans la session.

## Comment c'est vérifié

`tests/unit/secrets.test.ts` passe la **même batterie** au coffre système de la
machine qui l'exécute et au repli fichier : aller-retour, secret non-ASCII,
remplacement, suppression, absence, et — le cas qui compte — **deux références
qui ne se mélangent pas**. Elle ne connaît aucun coffre en particulier ; elle ne
parle qu'à `SecretVault`.

Une machine n'en prouve qu'un, d'où `.github/workflows/vault.yml` : macOS,
Windows, Linux avec trousseau, Linux sans. Chaque poste pose
`MIDGAARD_REQUIRE_VAULT` et la suite échoue si ce n'est pas ce coffre-là qui a
été retenu — sinon un poste sans trousseau passerait au vert sans rien éprouver.

### Ce que l'écriture de cette batterie a trouvé

Deux pannes, avant même son premier lancement, dans du code qui avait l'air juste :

- **DPAPI rangeait toutes les références dans un seul fichier.** La référence
  voyageait par `process.env`, que `run()` ne transmet pas : l'environnement du
  fils est reconstruit à partir d'une liste blanche où elle ne figurait pas. Le
  script PowerShell lisait `$null`, et `Join-Path $dir ($null + '.dpapi')`
  désignait toujours la même cible. Chaque clé déposée écrasait la précédente, et
  toute relecture rendait la dernière écrite — **sans la moindre erreur**. Un
  seul des six cas le voit : celui qui garde deux références vivantes en même
  temps. La référence passe désormais en argument de `run()`, ce qui règle au
  passage une course entre deux `set` simultanés.
- **libsecret se déclarait disponible sans bus de session.** `secret-tool` sort
  en 1 aussi bien pour « secret absent » que pour « bus injoignable », et la
  sonde acceptait les deux. Sur un serveur sans session graphique, libsecret
  était donc élu, puis échouait à chaque écriture. Ce qui distingue les deux cas
  est la sortie d'erreur : une absence est muette, une panne parle. Au passage,
  `DBUS_SESSION_BUS_ADDRESS` et `XDG_RUNTIME_DIR` manquaient à la liste blanche
  de `run()` — sans elles, `secret-tool` ne trouve pas le trousseau même là où
  il fonctionne.

Les deux étaient exactement ce que « écrit d'après la documentation, jamais
exécuté » laisse passer.

### Puis le premier passage en CI en a montré deux de plus

Le workflow a tourné le 2026-10-29. **macOS au vert, Linux sans trousseau au
vert, Windows et Linux-avec-trousseau au rouge** — et les deux rouges disaient
quelque chose de vrai :

- **DPAPI bloquait dix secondes par appel, puis se faisait tuer.** Le préambule
  PowerShell composait le chemin avec deux `Join-Path`, dont le paramètre est
  **obligatoire** : reçu `$null`, PowerShell ne lève pas, il **pose une
  question** et attend sur l'entrée standard — que `run()` ne fermait que
  lorsqu'il avait un secret à écrire. Six cas, six expirations. Deux
  corrections, toutes deux générales : le chemin se calcule désormais dans Node
  (`dpapiDir`, testable depuis n'importe quelle plateforme) et le script ne
  contient plus aucune applet dont un paramètre pourrait être nul ; et `run()`
  **ferme toujours** l'entrée standard, pour qu'une question lise une fin de
  fichier et échoue avec son message au lieu d'attendre.
- **`available()` prouve que le service répond, pas qu'il peut ranger.** Sur le
  runner, `secret-tool lookup` réussissait — code 1, sortie d'erreur muette,
  donc « disponible » — alors que le trousseau n'avait **aucune collection par
  défaut** et que chaque `store` échouait sur
  « Object does not exist at path …/collection/login ». C'est une limite réelle
  de la sonde, et elle est assumée : la combler demanderait d'écrire un secret
  d'essai à chaque démarrage. Ce qui est garanti, c'est que l'échec porte le
  message de `secret-tool`, et non un silence.

Troisième correction née de ces deux-là : **un utilitaire tué par le délai le
dit maintenant.** Il ressortait en « code 1 » avec une sortie d'erreur vide,
indistinguable d'un échec ordinaire — ce qui a coûté un aller-retour de CI pour
comprendre que DPAPI n'échouait pas, il attendait.

## API

```ts
const vault = await openVault(config, process.env)   // choisit, en mesurant
await vault.set('provider.venice', key)
const key = await vault.get('provider.venice')       // null si absent

// Clé d'un fournisseur : coffre d'abord, variable d'environnement en dépannage
const found = await resolveApiKey(vault, config.secret_ref, 'VENICE_API_KEY', process.env)
```

`MIDGAARD_VAULT` force un mécanisme (`macos-keychain`, `windows-dpapi`,
`libsecret`, `file`). Un coffre forcé et indisponible lève : les secrets ne
partent jamais ailleurs en silence.
