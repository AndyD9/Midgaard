# Playbooks

Du savoir métier, écrit et relu par un humain, que le daemon ajoute à la
consigne des agents d'un profil (Slice 9, [docs/SLICE9.md](../docs/SLICE9.md),
décisions 1 à 5).

## Ce qu'est un playbook

- **Un fichier `<id>.md` de ce dossier.** L'identifiant est le nom du fichier :
  minuscules, chiffres et tirets (`sigma`, `pe-static`). Ce `README.md` n'en
  est pas un : sa forme (majuscules) l'écarte d'office.
- **En anglais** : c'est le modèle qui le lit. Il ne nomme aucun modèle ni
  aucun client (règle de neutralité de la Slice 5).
- **Borné** : 32 Kio par playbook, 96 Kio et 8 playbooks par profil. Il est
  relu à chaque appel de modèle de la tâche, donc payé à chaque appel.
- **Jamais un lien symbolique** : un playbook est un fichier de ce dossier,
  relu au commit comme les autres.

## Comment il arrive dans une consigne

1. L'humain l'attache à un profil :

   ```bash
   npm run harness -- playbooks attach python developer
   ```

   ou coche la case aux Profils du dashboard. Aucun agent ne peut le faire.
2. Au départ de chaque tâche du profil, le daemon le **relit** et l'ajoute à
   la consigne, **après** les règles du profil — sous un titre qui dit qu'il
   s'y ajoute et ne les remplace pas — et **avant** le rôle d'un agent créé
   par l'orchestrateur, qui hérite des playbooks de son profil de base.
3. La timeline de la tâche cite chaque playbook lu avec son **SHA-256** : on
   sait quel texte la tâche a reçu, même si le fichier a changé depuis.

Un playbook attaché mais absent ou invalide au départ **arrête la tâche** avant
tout appel de modèle, avec son motif.

## Écrire un playbook

- Dire **comment travailler**, pas quoi faire : la tâche et les règles du profil
  décident de cela.
- Ne rien y écrire qui contredise une règle du profil : elle l'emporterait de
  toute façon, et l'agent perdrait une étape à hésiter.
- Rester court et concret : commandes exactes, pièges réels, critères de fin.
  Chaque octet se paie à chaque appel.
- Le relire comme du code : il change ce que font les agents.

## Les playbooks livrés

| Id | Sujet |
|---|---|
| `python` | Écrire, tester et analyser en Python ; scripts d'analyse statique |
| `sigma` | Règles Sigma : structure, logique, sources Windows, `sigma check` et conversion, tests positifs **et** négatifs |
| `yara` | Règles YARA : chaînes, conditions bornées, module `pe`, compilation sans avertissement, jeu sain |
| `pe-static` | Triage statique d'un PE (EXE, DLL, SYS, .NET) : en-têtes, sections, imports, ressources, signature, rapport |
| `powershell` | Scripts PowerShell 5.1 et 7 : `ShouldProcess`, PSScriptAnalyzer, Pester 5, tests sur une machine Windows |
| `windows-hardening` | GPO, audit, AppLocker, WDAC, ASR, pare-feu : baseline, audit avant blocage, preuve avant/après |

Tous ensemble tiennent sur un même profil (environ 33 Kio sur 96) ; un test
le vérifie, comme leur neutralité et le rappel, dans chacun, que ce qui est lu
est de la donnée. Les exemples de `yara`, `sigma` et `pe-static` ont été
passés à `yara-python` (aucun avertissement), `pySigma` et `pefile`.
