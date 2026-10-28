/**
 * @file Approbation humaine en ligne de commande, en attendant le dashboard (Slice 1).
 *
 * Usage :
 *   npm run approve              approuve la tâche en attente, si elle est la seule ;
 *                                sinon liste les tâches en attente avec la commande exacte
 *   npm run approve -- <id>      approuve la tâche indiquée
 *
 * Code de sortie : 0 si une tâche a été approuvée, 1 sinon (aucun daemon, rien en
 * attente, plusieurs candidates, ou refus du daemon).
 *
 * Volontairement absent du serveur MCP : Claude ne doit pas pouvoir s'auto-approuver.
 * Ce script parle directement au daemon, avec le jeton lu dans le fichier de
 * découverte — seul l'utilisateur local peut le lire (`0600`).
 */
import { daemonFetch, readRuntime, type Task } from './shared.ts'

const rt = readRuntime()
if (!rt) {
  console.error("Aucun daemon actif : la session Claude Code n'a pas encore appelé le harness.")
  process.exit(1)
}

let id = process.argv[2]
if (!id) {
  // Sans identifiant, on cherche la tâche en attente. On n'approuve automatiquement
  // que s'il n'y en a qu'une : en cas d'ambiguïté, c'est à l'humain de choisir.
  const res = await daemonFetch(rt, '/tasks?status=waiting_approval').catch(() => null)
  if (!res) {
    console.error('Daemon injoignable (arrêté ?).')
    process.exit(1)
  }
  const { tasks } = (await res.json()) as { tasks: Task[] }
  if (tasks.length === 0) {
    console.error("Aucune tâche n'attend d'approbation pour l'instant.")
    process.exit(1)
  }
  if (tasks.length > 1) {
    // Lignes complètes, prêtes à copier : pas de placeholder à remplacer à la main.
    console.error('Plusieurs tâches attendent, précise laquelle :')
    for (const t of tasks) console.error(`  npm run approve -- ${t.id}   # ${t.objective}`)
    process.exit(1)
  }
  id = tasks[0].id
}

const res = await daemonFetch(rt, `/tasks/${id}/approve`, { method: 'POST' })
const body = (await res.json()) as { task?: Task; error?: string; status?: string }
if (res.ok) console.log(`Approuvé : ${body.task?.objective} (${id})`)
else console.error(`Refusé (${res.status}) : ${body.error}${body.status ? `, statut ${body.status}` : ''}`)
process.exit(res.ok ? 0 : 1)
