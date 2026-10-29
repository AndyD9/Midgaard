/**
 * @file Point d'entrée de `@midgaard/mcp-server`.
 *
 * Expose le serveur sous forme de fabrique, pour que les tests puissent en
 * instancier un avec une configuration temporaire, sans passer par un processus.
 */
export { createMcpServer } from './server.ts'
export { approvalCommand, approvalInstructions } from './instructions.ts'
export { ensureDaemon, callDaemon } from './daemon-client.ts'
