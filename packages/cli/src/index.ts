/**
 * @file Point d'entrée de `@midgaard/cli`.
 *
 * La CLI s'utilise normalement par son binaire `harness` ; ces exports servent
 * aux tests, qui appellent les commandes dans le processus plutôt que d'en
 * lancer un.
 */
export { daemonCheck, decide, doctor, execAllowCheck, gitCheck, init, portFallbackNote, schemaCheck, start, status, stop, vaultAdvice, MIN_GIT } from './commands.ts'
export type { Check } from './commands.ts'
export { SERVER_NAME, findNode, mcpConfigPath, mcpServerEntry, writeMcpConfig } from './mcp-config.ts'
export type { McpServerEntry } from './mcp-config.ts'
export { exec, parseExecArgs, workspaces } from './workspaces.ts'
export { parseLimitsArgs } from './providers.ts'
export { absolutizeArgs, mcp, parseMcpAddArgs, readOnlyCandidates, resolveProgram } from './mcp.ts'
export type { McpAddArgs } from './mcp.ts'
export { parseWindowsAddArgs, windows } from './windows.ts'
export type { WindowsAddArgs } from './windows.ts'
export { extractHome } from './args.ts'
export { readSecret } from './secret-input.ts'
export type { SecretInput, SecretIo } from './secret-input.ts'
export { cmd, setAdviceHome } from './ui.ts'
