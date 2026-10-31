# `@midgaard/daemon`

Source de vérité du harness. Un seul daemon tourne par dossier runtime, quel que
soit le nombre de sessions Claude Code ouvertes.

```text
  session A ─ serveur MCP ─┐
  session B ─ serveur MCP ─┼─ HTTP 127.0.0.1 + jeton ─► daemon ─► SQLite
  CLI harness ─────────────┤                             │
  dashboard ───────────────┘                             └─ WebSocket ─► dashboard
```

| Module | Rôle |
|---|---|
| `daemon.ts` | Assemblage : verrou, base, bus, moteur, HTTP, WebSocket, bail, inactivité |
| `lock.ts` | Instance unique : création atomique du verrou, puis bail vérifié chaque seconde |
| `bus.ts` | **Seul chemin d'écriture** : ce qui est écrit est diffusé |
| `task-manager.ts` | Machine à états en marche ; tâches simulées en Slice 1 |
| `http.ts` | Routeur de l'API locale |
| `ws.ts` | Diffusion temps réel et **reprise sans trou** après coupure |
| `security.ts` | `Host` exact, `Origin` en liste blanche, `Sec-Fetch-Site`, jeton porteur |
| `static-files.ts` | Sert le dashboard compilé, ou explique comment le compiler |
| `main.ts` | Point d'entrée : **seul endroit** qui lit l'environnement |

## Ce qui change depuis la Slice 0

- **L'état est persisté.** Une tâche survit au redémarrage ; celles qui étaient
  actives deviennent `interrupted`, jamais reprises ni considérées réussies.
- **Le daemon s'arrête tout seul** après 30 minutes sans tâche active, sans
  dashboard connecté et sans requête. Celui de la Slice 0 survivait à toutes les
  sessions et finissait par tourner avec du code périmé.
- **La configuration est injectée** : seul `main.ts` lit `process.env`.
- **L'API est préfixée `/api`**, et le dashboard est servi sur la même origine.

## Modèle de menace de l'API locale

Écouter sur `127.0.0.1` ne suffit pas : **le navigateur de l'utilisateur est
local**, et une page malveillante peut lui faire émettre des requêtes. C'est la
menace réelle. Un autre processus du même utilisateur peut de toute façon lire le
fichier de découverte ; on ne prétend pas s'en protéger.

| Défense | Ce qu'elle arrête |
|---|---|
| `Host` exact (`127.0.0.1:<port>`) | DNS rebinding : la page fait pointer son domaine vers la boucle locale |
| `Origin` absente ou celle du dashboard | Requêtes inter-sites, y compris celles sans préflight |
| `Sec-Fetch-Site` ∈ {`same-origin`, `none`} | Confirmation directe par le navigateur |
| Jeton porteur, comparé à temps constant | Tout client qui n'a pas lu `daemon.json` (`0600`) |

Les fichiers d'état sont lisibles du seul utilisateur : `daemon.json`, le
journal et **la base**, en `0600` depuis la Slice 4 — elle était créée selon
l'umask, donc en `0644`, et gardait objectifs, contexte, sorties d'outils et
diffs à la portée des autres comptes du poste. Une base plus ancienne est
resserrée à l'ouverture. Prouvé par `tests/security.ts` (X4), qui vérifie aussi
qu'aucune autre interface que la boucle locale ne répond.

`/ui/bootstrap` et les fichiers du dashboard sont servis **sans jeton** — le
navigateur n'en a aucun avant d'avoir chargé la page — mais restent soumis aux
contrôles d'enveloppe, qui sont précisément ce qui arrête une page hostile.

## Installation

`/api/health` annonce `install` : le dossier canonique du paquet
`@midgaard/daemon` et sa version (`installation.ts`, exporté seul par
`@midgaard/daemon/installation` pour que le serveur MCP ne charge pas tout le
daemon). `POST /api/shutdown` accepte `{ "if_idle": true }`, qui rend `409`
tant qu'une tâche est active : c'est ainsi qu'un serveur MCP d'une autre
installation remplace ce daemon sans jamais interrompre de travail.

Le dashboard est cherché d'abord dans `dashboard/`, à côté de `dist/` — là où
l'assemblage du paquet npm le range —, puis dans `apps/dashboard/dist` du dépôt.

## Instance unique

Verrou créé **avec son contenu** (`link` sur un fichier temporaire portant déjà le
pid), puis bail vérifié chaque seconde : un daemon qui ne lit plus son pid dans le
verrou s'arrête. Deux daemons peuvent coexister au plus une seconde, au démarrage,
sans tâche en cours. Le détail de la course et de sa correction est dans
[`docs/SLICE0.md`](../../docs/SLICE0.md).

## Variables d'environnement

Lues **uniquement** par `main.ts`, via `loadConfig`.

| Variable | Défaut | Effet |
|---|---|---|
| `MIDGAARD_HOME` | `~/.midgaard` | Dossier d'état runtime (base, verrou, journal) |
| `MIDGAARD_PORT` | `7777`, repli sur un port libre | Port d'écoute. Fixé explicitement, un port occupé devient une erreur |
| `MIDGAARD_IDLE_SHUTDOWN_S` | `1800` | Inactivité avant arrêt ; `0` désactive |
| `MIDGAARD_APPROVAL_TTL_S` | `600` | Délai de décision humaine ; au-delà la tâche passe en `timed_out` |
| `MIDGAARD_DASHBOARD_DIR` | `apps/dashboard/dist` | Fichiers compilés du dashboard |
