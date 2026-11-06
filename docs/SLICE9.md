# Slice 9 — Des agents experts : Python, reverse, règles Windows

**Date :** 2026-11-06 · **Objectif :** que les agents de Midgaard travaillent
en experts sur quatre terrains — **détection** (Sigma, YARA, EVTX, Sysmon),
**durcissement** (GPO, AppLocker, WDAC, pare-feu, ASR), **scripts
PowerShell**, **analyse de binaires PE** — le plus souvent en **Python**, et
vérifient sous Windows ce qui ne se vérifie que là.

**État : décidée, pas commencée.** Elle vient **après** l'essai réel REA
(étape 7 de la Slice 8), qui reste à rejouer : c'est le socle du reverse.
Les releases desktop (prévues après la Slice 8) passent après elle.

---

## Les décisions prises avec l'auteur (2026-11-06)

| Question | Réponse retenue |
|---|---|
| Quelles « règles Windows » ? | **Les quatre** : détection (Sigma, YARA), durcissement / GPO, scripts PowerShell, analyse de binaires PE |
| Où vérifier ce qui est propre à Windows ? | **Une VM Windows jointe par SSH**, où `exec` peut lancer des commandes, approuvées |
| Dans quel ordre ? | **Conclure l'essai REA, puis cette slice**, puis les releases desktop |
| Quel modèle ? | **Les modèles *uncensored* de Venice**, à commencer par `deepseek-v4-1-flash-uncensored` |

## Ce qui a été constaté avant de décider (2026-11-06)

Chaque point a été lu dans le code ou au catalogue, pas supposé.

1. **Les profils ne savent aucun métier.** Les consignes du Researcher, du
   Developer et du Navigator (`packages/daemon/src/agents.ts`) ne disent que
   les règles du harness. Le rôle d'un agent créé (`create_agent`) est écrit
   par l'orchestrateur à chaque tâche, et perdu avec elle : rien ne
   s'accumule.
2. **Seul le Developer exécute.** Le Researcher est en lecture seule ; faire
   tourner un script d'analyse Python demande un Developer dans un worktree,
   chaque commande approuvée.
3. **La liste blanche `exec` compare l'argv à la lettre** (`execAllowed`,
   `packages/tools/src/exec.ts`) : une entrée `python -m pytest` ne couvre
   pas `python -m pytest -k foo`. En Python, c'est une approbation par
   itération.
4. **Un worktree n'a pas de `.venv`** (non versionné) : une tâche Developer
   doit recréer l'environnement avant de pouvoir tester.
5. **Le modèle existe et se règle déjà.** Au catalogue public de Venice
   (relu le 2026-11-06) : `deepseek-v4-1-flash-uncensored` et
   `deepseek-v4-1-flash-1017-uncensored` — appel d'outils, vision, contexte
   d'un million de jetons, effort de raisonnement réglable (`high` par
   défaut chez Venice) ; 0,33 $ / 1,32 $ par million de jetons, cache à
   0,00825 $. Les deux sont **déjà tarifés** dans
   `packages/providers/pricing.json` : on peut les poser sur un profil
   aujourd'hui (`PATCH /api/agents/:id`, ou les Profils du dashboard), et
   `create_agent` les accepte. L'adaptateur n'envoie aucun
   `reasoning_effort` : c'est le défaut de Venice qui joue.
6. **Rien ne touche Windows depuis le poste de l'auteur** (un Mac), hors de
   la CI.

## Ce que la slice devra apporter (à découper)

Pistes, dans l'ordre de leur valeur estimée. Aucune n'est faite.

- **Des playbooks attachés à un profil** : des fichiers Markdown versionnés,
  relus par l'humain, ajoutés à la consigne — la mémoire métier qui manque
  (Sigma, YARA, PE, PowerShell, durcissement). Les agents créés en héritent
  de leur profil de base.
- **Une liste blanche `exec` à motifs bornés** : un préfixe par outil
  (`python -m pytest …`, `ruff check …`, `yara …`), jamais `python` seul.
  Un `pytest` déjà permis lance du code écrit par l'agent (`conftest.py`) :
  ouvrir ses arguments n'élargit pas ce qui tourne ; ouvrir `python
  script.py` le ferait.
- **Un environnement Python préparé** au départ d'un worktree (`uv`), par le
  harness et non par l'agent.
- **Une cible Windows par SSH** pour `exec`.
- **Des profils métier** livrés d'office ou déclarés par l'humain, si les
  playbooks sur les profils existants ne suffisent pas.
- **Choisir les outils d'un serveur MCP exposés à un profil** (laissé
  ouvert par la Slice 8 : REA en annonce 207, ~55 000 jetons).

## Reste à trancher

- **Le modèle de sécurité de la cible SSH.** Les invariants d'`exec` doivent
  tenir de l'autre côté : l'approbation porte sur la commande exacte, et
  **aucun processus ne survit**. La garde locale ne peut rien tuer sur la VM
  si le daemon meurt net : il faudra un mécanisme côté Windows (Job Object,
  délai imposé à distance). La clé SSH va au coffre, l'empreinte d'hôte est
  épinglée. Et comment les fichiers du worktree arrivent sur la VM (copie
  par tâche, dossier jetable) : la VM ne doit jamais écrire dans le dépôt de
  l'utilisateur.
- **Aucun échantillon n'est exécuté** — recommandation, à confirmer.
  L'analyse reste statique, même avec une VM : elle n'est pas un bac à
  sable, et Midgaard n'en fournit pas.
- **Un modèle *uncensored* obéit plus volontiers.** Les chaînes d'un binaire,
  un journal EVTX ou un commentaire de script sont des données qu'un
  attaquant a pu écrire. Les protections de Midgaard sont dans le code
  (encadrement à nonce, approbations, liste blanche), pas dans le refus du
  modèle : la slice ne doit en relâcher aucune, et l'approbation reste la
  frontière.
- **Le format et la portée des playbooks** : par profil, par dépôt (`.midgaard/`
  dans le projet), ou les deux ; qui les relit, et comment le dashboard les
  montre.
- **Régler l'effort de raisonnement** par profil, ou laisser le défaut du
  fournisseur.
