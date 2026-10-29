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
- **Windows et Linux ne sont pas vérifiés automatiquement.** La suite de tests
  exerce le repli fichier sur toutes les plateformes, et le trousseau macOS sur
  macOS. Les deux autres sont écrits d'après leurs documentations et restent à
  éprouver sur machine réelle.

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
