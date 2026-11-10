/**
 * @file Point d'entrée de `@midgaard/remote` : la connexion SSH à la VM
 * Windows de test (Slice 9, étape 5). Ne connaît ni le daemon, ni la base,
 * ni les approbations.
 */
export { generateKeyPair, fingerprintOf, fingerprintOfPublicKey, normalizeFingerprint } from './keys.ts'
export type { GeneratedKeyPair } from './keys.ts'
export { RemoteError, RemoteSession, UPLOAD_MAX_BYTES, UPLOAD_MAX_FILES } from './connection.ts'
export type { RemoteErrorKind, RemoteRunOptions, RemoteRunResult, RemoteTarget, UploadSummary } from './connection.ts'
export { POWERSHELL, powershellCommand, scriptOfPowershellCommand } from './powershell.ts'
