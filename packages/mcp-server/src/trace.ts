/**
 * @file Trace de diagnostic des attentes, en JSONL.
 *
 * Elle existe pour une raison précise : **la suite de tests ne peut pas simuler
 * le vrai client Claude Code**. C'est en relisant cette trace qu'on a mesuré, en
 * Slice 0, qu'il envoie un jeton de progression à chaque appel, qu'il choisit
 * lui-même ses délais, et qu'une attente de 248 s tient sans coupure.
 *
 * Un fichier plutôt que stderr, parce que Claude Code n'affiche pas le stderr des
 * serveurs MCP.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import type { HarnessConfig } from '@midgaard/contracts'

/** Écrit une ligne de trace. Ne lève jamais : un échec de diagnostic ne doit pas
 * faire échouer un appel d'outil. */
export function createTracer(config: HarnessConfig, client: () => unknown) {
  return function trace(event: string, data: Record<string, unknown>): void {
    try {
      mkdirSync(config.home, { recursive: true, mode: 0o700 })
      appendFileSync(
        config.traceFile,
        JSON.stringify({ at: new Date().toISOString(), event, client: client(), ...data }) + '\n',
        { mode: 0o600 },
      )
    } catch {}
  }
}
