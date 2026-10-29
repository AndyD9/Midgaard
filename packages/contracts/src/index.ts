/**
 * @file Point d'entrée de `@midgaard/contracts` : tout ce que les autres paquets
 * sont autorisés à connaître du modèle commun.
 *
 * Ce paquet ne dépend d'aucun autre paquet du monorepo, et n'a aucun effet de
 * bord au chargement. Il est la source de vérité unique : les schémas Zod servent
 * à la fois à valider les entrées MCP, à décrire l'API HTTP et à typer le dashboard.
 */
export * from './config.ts'
export * from './task.ts'
export * from './events.ts'
export * from './approvals.ts'
export * from './protocol.ts'
export * from './runtime.ts'
export * from './client.ts'
