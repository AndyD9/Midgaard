/**
 * @file Point d'entrée de `@midgaard/cli`.
 *
 * La CLI s'utilise normalement par son binaire `harness` ; ces exports servent
 * aux tests, qui appellent les commandes dans le processus plutôt que d'en
 * lancer un.
 */
export { decide, doctor, execAllowCheck, gitCheck, init, start, status, stop, vaultAdvice, MIN_GIT } from './commands.ts'
export type { Check } from './commands.ts'
export { SERVER_NAME, findNode, mcpConfigPath, mcpServerEntry, writeMcpConfig } from './mcp-config.ts'
export type { McpServerEntry } from './mcp-config.ts'
export { exec, parseExecArgs, workspaces } from './workspaces.ts'
