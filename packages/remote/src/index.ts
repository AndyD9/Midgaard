/**
 * @file Point d'entrée de `@midgaard/remote` : la connexion SSH à la VM
 * Windows de test (Slice 9, étape 5). Ne connaît ni le daemon, ni la base,
 * ni les approbations.
 */
export { generateKeyPair, fingerprintOf, fingerprintOfPublicKey, isUsableKeyPair, normalizeFingerprint } from './keys.ts'
export type { GeneratedKeyPair } from './keys.ts'
export { RemoteError, RemoteSession, REMOVE_MAX_ENTRIES, UPLOAD_MAX_BYTES, UPLOAD_MAX_FILES } from './connection.ts'
export type { RemoteErrorKind, RemoteRunOptions, RemoteRunResult, RemoteTarget, RemoveSummary, UploadSummary } from './connection.ts'
export { REMOTE_TASK_ID_PATTERN, isStrictlyUnder, remoteTaskDir } from './task-dir.ts'
export type { RemoteTaskDir } from './task-dir.ts'
export { POWERSHELL, powershellCommand, scriptOfPowershellCommand } from './powershell.ts'
