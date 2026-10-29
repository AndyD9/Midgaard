#!/usr/bin/env node
/**
 * @file Point d'entrée du serveur MCP, lancé par Claude Code en stdio.
 *
 * Seul endroit du paquet qui lit l'environnement. Le daemon n'est **pas** démarré
 * ici mais au premier appel d'outil : une session Claude Code qui n'utilise jamais
 * le harness ne lance aucun processus en arrière-plan.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadConfig } from '@midgaard/contracts'
import { createMcpServer } from './server.ts'

// stdout est le canal JSON-RPC : toute journalisation passe par stderr.
const log = (...a: unknown[]) => console.error(new Date().toISOString(), '[mcp]', ...a)

const server = createMcpServer(loadConfig(process.env), log)
await server.connect(new StdioServerTransport())
log('serveur MCP prêt sur stdio')
