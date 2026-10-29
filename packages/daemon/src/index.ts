/**
 * @file Point d'entrée de `@midgaard/daemon`.
 *
 * Expose de quoi démarrer un daemon dans le processus courant (tests), et les
 * briques que le serveur MCP ou la CLI doivent connaître.
 */
export { startDaemon, defaultDashboardDir } from './daemon.ts'
export type { Daemon, StartOptions } from './daemon.ts'
export { EventBus } from './bus.ts'
export { TaskManager, STEPS_TOTAL, APPROVAL_STEP } from './task-manager.ts'
export type { Refusal, TaskView } from './task-manager.ts'
export { acquireLock, readLockPid, releaseLock, tryCreateLock } from './lock.ts'
export { WS_PATH } from './ws.ts'
export { StaticFiles } from './static-files.ts'
