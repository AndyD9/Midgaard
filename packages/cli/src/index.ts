/**
 * @file Point d'entrée de `@midgaard/cli`.
 *
 * La CLI s'utilise normalement par son binaire `harness` ; ces exports servent
 * aux tests, qui appellent les commandes dans le processus plutôt que d'en
 * lancer un.
 */
export { decide, doctor, init, start, status, stop } from './commands.ts'
export { SERVER_NAME, findNode, mcpConfigPath, mcpServerEntry, writeMcpConfig } from './mcp-config.ts'
export type { McpServerEntry } from './mcp-config.ts'
