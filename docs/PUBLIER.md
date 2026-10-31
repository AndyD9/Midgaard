# Publier `midgaard` sur npm

Procédure du mainteneur. Décision de la Slice 4 : **la CI publie, pas un
poste**, sur tag `v…`, avec une attestation de provenance
(`.github/workflows/publish.yml`). Une version publiée ne se republie jamais
sous le même numéro : tout ce qui peut échouer est vérifié avant.

## Ce que fait le workflow

| Job | Ce qu'il prouve |
|---|---|
| Contrôles | Le tag est `v` + la version du `package.json` ; cette version n'est pas déjà publiée ; le commit est sur `main` ; npm sait faire la publication de confiance (≥ 11.5.1) — `scripts/release.ts check` |
| Bout en bout | Toutes les suites, sur macOS, Linux et Windows, **sur ce commit** — `e2e.yml` appelé tel quel |
| Paquet | Le tarball, assemblé **une seule fois** (`npm run pack:npm`), et son empreinte |
| Éprouvé | **Ce** tarball installé comme un tiers (`tests/package.ts`), sur les trois plateformes |
| Publication | **Ce** tarball publié, puis la vérification que le registre sert les mêmes octets (`scripts/release.ts published`) |

Lancé à la main (onglet *Actions*, « Publication », *Run workflow*, branche
`main`), c'est une **répétition générale** : tout, mais `npm publish` reçoit
`--dry-run`. Elle n'éprouve ni l'authentification ni la provenance — npm ne
les exerce pas à blanc —, seulement tout ce qui les précède.

## Une fois pour toutes

### 1. L'environnement GitHub `npm`

*Settings → Environments → New environment*, nommé **`npm`** :

- **Required reviewers** : toi. Chaque publication attend alors un clic
  humain, après les tests et avant `npm publish`.
- **Deployment branches and tags** : *Selected branches and tags*, avec la
  règle de tag `v*` et la branche `main` (pour la répétition générale).

Le nom compte : npm vérifiera que la publication vient de cet environnement.

### 2. La toute première version : un jeton temporaire

La publication de confiance ne se configure que sur un paquet **qui existe
déjà** (documentation de `npm trust`, relue le 2026-10-31). La 0.1.0 passe donc
par un jeton, mais **toujours depuis la CI**, avec provenance :

1. Sur npmjs.com, *Access Tokens → Generate New Token → Granular Access Token* :
   permission *Read and write* sur *All packages* (le paquet n'existe pas
   encore), expiration la plus courte possible, et *Bypass 2FA* coché — la CI
   ne peut pas saisir de code.
2. Dans le dépôt, *Settings → Environments → npm → Environment secrets* :
   un secret **`NPM_TOKEN`** contenant ce jeton. Rangé dans l'environnement, il
   n'est lisible que par le job de publication.
3. Publier la version (ci-dessous). Le job « Authentification » le dit par un
   avertissement : « Publication par jeton (amorçage) ».

### 3. Passer à la publication de confiance

Aussitôt la 0.1.0 publiée :

1. Sur npmjs.com, page du paquet → *Settings → Trusted Publisher → GitHub
   Actions* : organisation ou utilisateur `AndyD9`, dépôt `Midgaard`, workflow
   `publish.yml`, environnement `npm`.
2. Toujours dans *Settings*, *Publishing access* : exiger la 2FA **et
   interdire les jetons**. Plus rien ne publie alors que ce workflow.
3. **Supprimer le secret `NPM_TOKEN`** de l'environnement, et **révoquer** le
   jeton sur npmjs.com. Sans le secret, le workflow passe par l'OIDC, sans rien
   changer d'autre.

## À chaque version

1. Changer la version, à la racine seulement — l'assemblage la recopie dans
   les dix paquets embarqués :

   ```bash
   npm version 0.1.1 --no-git-tag-version
   ```

2. Vérifier sur le poste ce que le workflow vérifiera :

   ```bash
   node scripts/release.ts check
   ```

3. Commiter sur `main`, pousser, attendre « Bout en bout » au vert.
4. Poser le tag et le pousser :

   ```bash
   git tag v0.1.1 && git push origin v0.1.1
   ```

5. Approuver le déploiement dans l'onglet *Actions* quand le workflow le
   demande — après les tests sur les trois plateformes.
6. Vérifier depuis une installation jetable (voir le README du paquet,
   « Vérifier la provenance »).

## Quand ça échoue

- **Contrôles** : le message dit lequel. Un tag qui ne correspond pas à la
  version se retire (`git push origin :refs/tags/v0.1.1`), puis se repose
  sur le bon commit.
- **`npm publish` en `E404` ou `ENEEDAUTH`**, sans jeton : la configuration de
  confiance ne correspond pas — dépôt, nom du workflow ou environnement, à la
  casse près ; ou le `repository.url` du paquet ne désigne plus
  `github.com/AndyD9/Midgaard`.
- **« le registre sert un autre tarball »** : la version est publiée, mais pas
  celle qui a été éprouvée. Elle ne se reprend pas ; la déprécier
  (`npm deprecate`) et publier la suivante, puis chercher ce qui a pu la
  réassembler.
