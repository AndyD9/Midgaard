# `@midgaard/agent-runtime`

La boucle d'exécution d'un agent. Elle ne connaît **ni le daemon, ni la base, ni
le coffre** : elle reçoit un adaptateur, un contexte d'outils et des crochets.

C'est ce qui permet de l'éprouver avec un faux fournisseur, sans réseau et sans
dépense — et donc de vérifier à chaque exécution de la suite que le budget
arrête bien la tâche **avant** l'appel de trop, sans payer pour le constater.

## Une itération

```text
 1. limites : annulation, délai, étapes, budget   ← AVANT l'appel modèle
 2. appel modèle
 3. consommation cumulée, diffusée
 4. pour chaque appel d'outil :
      schéma Zod → politique → [approbation humaine] → exécution → journal
 5. réinjection des résultats, et on recommence
```

L'ordre de l'étape 1 est celui du plan (§4), et il compte : une limite constatée
après l'appel a déjà été payée. Un budget qui se contente de constater n'est pas
un budget.

## Quatre décisions à connaître avant d'y toucher

**La fin est un acte, pas une interprétation.** Seul `submit_result` termine une
tâche. Un modèle qui écrit « voilà, j'ai fini » sans l'appeler n'a pas fini : il
a cessé de parler. La boucle le relance **une fois**, puis échoue en le disant.

**Et elle dit *pourquoi* il n'a rien appelé.** « Aucun outil appelé » est un
symptôme, pas une cause. Dans un cas la réponse a été **coupée au plafond de
sortie** avant que l'appel n'ait pu être émis ; dans l'autre le modèle a
réellement cessé de conclure. Les deux se corrigent à l'opposé — raccourcir la
réponse demandée, ou reformuler l'objectif — et la boucle compte les troncatures
pour les distinguer dans son motif d'échec.

Ce n'est pas une précaution théorique : avec l'ancien message, qui ne disait que
le symptôme, le lecteur a imputé l'échec au plafond d'étapes qu'il venait de
poser — et a publié ce diagnostic, faux. Un message incomplet ne laisse pas son
lecteur sans réponse, il lui en fait inventer une.

**Un conseil doit viser une manette que son lecteur peut atteindre.** La boucle
conseillait de « relever `max_output_tokens` » : ce plafond appartient au
profil, et `tightenLimits` ne sait qu'abaisser — relever est impossible depuis
une délégation. Les conseils renvoient désormais à l'objectif, ou à `max_steps`
jusqu'au plafond du profil.

**Tout ce qui vient du dehors est encadré, même pour l'agent.** Un résultat
`untrusted` est enveloppé avant d'être réinjecté dans la conversation de l'agent
lui-même, pas seulement avant de remonter à Claude. L'agent est la première
cible d'une page qui essaie de détourner la tâche. Un fichier du projet n'est
**pas** encadré : banaliser le marqueur le viderait de son sens.

**Les limites sont dites au modèle.** Elles sont appliquées par le code de toute
façon, mais un agent qui ignore qu'il n'a que douze étapes les dépense à
explorer, puis se fait couper sans rien rendre. Lui dire son budget change sa
stratégie, pas seulement son information.

**Un budget inapplicable est annoncé comme tel.** Si le tarif du modèle est
inconnu, la dépense ne peut pas être plafonnée en dollars — seules les étapes et
le délai bornent la tâche. La boucle le dit **une fois**, plutôt que de laisser
croire à une protection qui n'opère pas.

## Statuts d'arrêt

| Raison | Statut | Pourquoi pas `failed` |
|---|---|---|
| budget atteint | `budget_exceeded` | rien n'a échoué, un plafond a été atteint |
| délai dépassé | `timed_out` | idem |
| annulation | `cancelled` | demandée par un humain |
| étapes épuisées sans résultat | `failed` | là, quelque chose n'a pas marché |

Confondre les deux premiers avec `failed` enverrait l'utilisateur chercher un
bogue là où il n'y a qu'une limite à relever.

## Contexte

C'est **Claude Code** qui fournit le contexte (§4 du plan). Le runtime y ajoute
seulement l'arborescence du workspace, bornée à deux niveaux, et les consignes du
profil. Un agent qui commencerait par lire trente fichiers pour comprendre où il
est dépenserait plus que la question ne valait, et déléguer deviendrait plus cher
que faire soi-même.
