# Midgaard

Harness local qui permet à **Claude Code** de déléguer des tâches à des agents
exécutants, de **voir ce qu'ils font**, et de leur imposer un **budget** et une
**approbation humaine** pour les actions sensibles.

Claude Code reste l'orchestrateur : il planifie, délègue et intègre les
résultats. Midgaard gère les tâches, l'exécution, les permissions, les traces et
les coûts, dans un daemon local qui n'écoute que sur `127.0.0.1`, avec un
dashboard dans le navigateur et une CLI, `harness`.

> Ce texte est le README du paquet npm `midgaard`. Les sources, la
> documentation complète et le récit des décisions sont sur
> [GitHub](https://github.com/AndyD9/Midgaard).

## Prérequis

- **Node 24 ou plus** — `node:sqlite` y est intégré, sans drapeau expérimental ;
- **Git 2.17 ou plus**, pour l'agent `developer` (le `researcher` s'en passe) ;
- **Claude Code**, app desktop ou CLI.

Plateformes : les essais en vraie session ont eu lieu **sous macOS**. Sous
**Linux et Windows**, le paquet est éprouvé **en CI seulement** — installé dans
un dossier vierge, puis `init`, `doctor`, un vrai client MCP et une tâche, face
à un faux fournisseur. C'est une preuve de fonctionnement, pas d'ergonomie.

## Installer

```bash
npm install -g midgaard
```

```bash
harness --version
```

Puis, **dans le dossier du projet** où Claude Code travaillera :

```bash
harness init
```

```bash
harness doctor
```

`init` déclare le serveur MCP `midgaard` dans le `.mcp.json` du dossier, avec
des chemins absolus propres à cette machine : **ne le versionne pas**.
`doctor` dit ce qui manque et la commande qui le corrige ; ses avertissements
ne sont pas des échecs.

Ouvre ensuite une **nouvelle** session Claude Code sur ce dossier et accepte le
serveur `midgaard` quand il est proposé : Claude Code ne relit `.mcp.json`
qu'à l'ouverture d'une session.

Le daemon démarre tout seul au premier appel d'outil, et s'arrête après
30 minutes sans tâche, sans dashboard ouvert et sans requête. Son état — base,
journal, jeton d'accès, worktrees — vit dans `~/.midgaard`.

### Vérifier la provenance

Chaque version est publiée par la CI du dépôt, depuis le commit taggé, avec une
attestation de provenance. `npm audit signatures` ne vérifie pas les paquets
globaux (il refuse : `EAUDITGLOBAL`) ; on le lance donc sur une installation
jetable, sous macOS ou Linux :

```bash
mkdir -p /tmp/midgaard-verif && cd /tmp/midgaard-verif && npm init -y && npm install midgaard && npm audit signatures
```

La sortie doit compter `midgaard` parmi les paquets aux attestations vérifiées
(« … have verified attestations »). La page du paquet sur npmjs.com nomme aussi
le commit et le workflow qui l'ont construit.

## Premier essai, sans rien dépenser

Le profil `simulated` n'appelle aucun modèle : des étapes minutées, utiles pour
voir le circuit complet. Dans la session Claude Code, demande :

> Utilise le harness midgaard. Délègue « test approbation » à l'agent
> `simulated` avec `duration_s` 20 et `needs_approval` true, et attends-la
> jusqu'au bout en suivant `next_action`.

Quand la tâche se met en pause, Claude te transmet la consigne d'approbation.
Ouvre le dashboard sur **http://127.0.0.1:7777** et approuve — ou, dans un
terminal :

```bash
harness approve
```

**Claude ne peut pas s'approuver lui-même** : aucun outil d'approbation ne lui
est exposé. La décision passe par toi, dans le dashboard ou la CLI.

## Déclarer un fournisseur de modèles

Sans fournisseur, seul `simulated` tourne ; le `researcher` et le `developer`
sont visibles mais **désactivés**, et disent pourquoi. Pour Venice :

```bash
harness providers add venice --model deepseek-v4-flash-0731
```

La clé est demandée **sans écho** et déposée dans le coffre système (trousseau
macOS, DPAPI sous Windows, libsecret sous Linux). Elle n'apparaît ni dans la
ligne de commande, ni dans l'historique du shell, ni en base. La commande teste
la connexion — et ce test prouve la **clé**, pas seulement que l'endpoint répond.

`--preset openai` ou `--preset gemini` visent les autres fournisseurs ;
`--preset custom --base-url …` vise tout endpoint compatible OpenAI.

```bash
harness agents
```

```bash
harness pricing refresh venice
```

## Les agents

- **`researcher`** lit le dépôt d'où la tâche est déléguée, et le web
  (`http_fetch`, recherche du fournisseur). Il n'écrit rien.
- **`developer`** travaille dans un **worktree Git** sous
  `~/.midgaard/worktrees`, jamais dans ton dépôt. Chaque commande qu'il veut
  lancer attend ton approbation ; le diff se lit sur le dashboard. À la fin, son
  travail est commité sur une branche `midgaard/…` — **le harness ne merge
  jamais** : c'est toi qui décides.

```bash
harness workspaces
```

```bash
harness workspaces clean
```

Un exemple, depuis une session ouverte sur un dépôt Git propre :

> Utilise le harness midgaard. Délègue au `developer` : « Ajoute une route
> GET /health qui répond 200 avec {"status":"ok"}, et un test pour elle.
> Vérifie avec npm test. » Passe-lui en `context` ce que tu sais du dépôt,
> limite le budget à 0,10 $, et attends le résultat.

## Budgets et coûts

Chaque profil a un budget, un nombre d'étapes et un délai ; une délégation peut
les **abaisser**, jamais les relever. Ils sont vérifiés **avant** chaque appel
au modèle. Un coût est toujours affiché avec sa provenance — facturé par le
fournisseur, estimé depuis les tarifs locaux, ou inconnu — et jamais `0 $`
faute de tarif.

Retiens qu'**une tâche qui échoue a déjà dépensé**. La cause la plus fréquente
n'est pas une limite trop basse mais un objectif qui appelle une réponse trop
longue : demande une réponse courte et bornée.

## La CLI

| Commande | Rôle |
|---|---|
| `harness init [dossier]` | Déclare le serveur MCP dans le `.mcp.json` du dossier |
| `harness doctor` | Diagnostic de l'installation, avec la commande qui corrige |
| `harness start`, `harness stop` | Démarre le daemon s'il dort ; l'arrête |
| `harness status` | État du daemon et tâches récentes — même daemon arrêté |
| `harness approve`, `harness reject` | Décide d'une demande d'approbation |
| `harness agents` | Profils d'exécution, et pourquoi certains sont désactivés |
| `harness providers` | Fournisseurs : `add`, `test`, `remove` |
| `harness pricing` | Tarifs en vigueur ; `refresh` les relève chez le fournisseur |
| `harness workspaces` | Worktrees du `developer` : `remove`, `clean` — la branche reste toujours |
| `harness exec` | Commandes lancées sans approbation dans ce dépôt : `allow`, `revoke` |

`harness --help` donne le détail de chaque commande et les variables
d'environnement.

## Sécurité, en une phrase honnête

Isolation **logique**, pas une sandbox OS : le daemon n'écoute que sur
`127.0.0.1`, exige un jeton, refuse tout `Host` et toute `Origin` étrangers ; un
agent ne lit que le dépôt d'où la tâche est déléguée, n'écrit que dans son
worktree, ne joint jamais une adresse privée, et ce qui revient du web est
encadré comme de la donnée, jamais une instruction. Un agent compromis pourrait
néanmoins lire ce que ton compte utilisateur peut lire. Le modèle de menace est
dans [packages/daemon/README.md](https://github.com/AndyD9/Midgaard/blob/main/packages/daemon/README.md).

## Mettre à jour, désinstaller

```bash
npm install -g midgaard@latest
```

Un daemon de l'ancienne version est remplacé au prochain appel s'il n'a aucune
tâche en cours ; sinon il termine son travail d'abord. Si `doctor` signale une
déclaration MCP qui pointe vers des chemins disparus (après un changement de
version de Node, par exemple), relance `harness init`.

Pour désinstaller, retire d'abord les clés déposées dans le coffre système,
puis le paquet :

```bash
harness providers remove venice
```

```bash
harness stop
```

```bash
npm uninstall -g midgaard
```

`~/.midgaard` reste : il contient l'historique des tâches et les worktrees
conservés. Supprime-le toi-même quand tu n'en as plus besoin ; les branches
`midgaard/…` de tes dépôts restent aussi.

## En cas de panne

Commence par `harness doctor`. Les symptômes connus, leur cause et leur remède
sont dans le [guide de dépannage](https://github.com/AndyD9/Midgaard/blob/main/docs/DEPANNAGE.md).

## Licence

MIT.
