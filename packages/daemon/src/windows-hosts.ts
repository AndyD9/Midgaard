/**
 * @file Service des VM Windows de test (Slice 9, étape 5.2) : déclarer,
 * tester, retirer.
 *
 * Calqué sur les fournisseurs et les serveurs MCP :
 *
 *  - **le coffre d'abord, la base ensuite.** La clé privée est générée ici,
 *    déposée au coffre, et la base n'en reçoit que la moitié publique. Écrire
 *    la base d'abord laisserait une VM déclarée dont la clé n'existe pas ;
 *  - **la clé privée ne sort jamais du daemon** : ni réponse HTTP, ni
 *    journal, ni CLI. Seule la clé publique circule, avec la commande qui la
 *    pose sur la VM ;
 *  - **un test prouve ce qu'il annonce** : il joint l'hôte épinglé avec la
 *    clé du coffre et fait répondre PowerShell. Un hôte qui présente une autre
 *    empreinte échoue, et le test dit celle qu'il a vue.
 */
import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import {
  windowsInstallCommands,
  type UpsertWindowsHostRequest,
  type WindowsHost,
  type WindowsHostView,
  type WindowsTest,
} from '@midgaard/contracts'
import { generateKeyPair, normalizeFingerprint, powershellCommand, RemoteError, RemoteSession } from '@midgaard/remote'
import type { ProviderRefusal, ProviderServiceDeps } from './providers.ts'

/** Ce dont le service a besoin : le même socle que celui des fournisseurs. */
export type WindowsServiceDeps = Pick<ProviderServiceDeps, 'config' | 'store' | 'vault' | 'log'>

/** Délai de connexion d'un test, poignée de main comprise. */
export const WINDOWS_TEST_CONNECT_MS = 15_000
/** Délai de la commande d'un test : un premier PowerShell peut être lent à charger. */
export const WINDOWS_TEST_RUN_MS = 60_000

/**
 * Le script d'un test : la version de PowerShell, puis celle de Windows, une
 * par ligne. Rien n'est écrit sur la VM.
 */
export const WINDOWS_TEST_SCRIPT = '$PSVersionTable.PSVersion.ToString()\n[Environment]::OSVersion.VersionString'

/**
 * Référence de la clé privée d'une VM au coffre, dérivée comme celle d'une
 * clé de fournisseur : l'empreinte du dossier runtime sépare deux
 * installations d'une même session, que le coffre système ne sépare pas.
 *
 * @returns par exemple `windows.3f9a0c21.vm1`
 */
export async function windowsKeyRef(home: string, id: string): Promise<string> {
  const canonical = await realpath(home).catch(() => home)
  return `windows.${createHash('sha256').update(canonical).digest('hex').slice(0, 8)}.${id}`
}

/** Une VM et les commandes à lancer sur elle. */
export function windowsHostView(host: WindowsHost): WindowsHostView {
  return { ...host, install_commands: windowsInstallCommands(host.public_key) }
}

/**
 * Déclare ou met à jour une VM.
 *
 * À la création, l'empreinte est exigée et une clé est générée. À la mise à
 * jour, l'empreinte donnée remplace l'épinglée, sinon elle reste ; la clé ne
 * change que sur demande (`new_key`), et l'ancienne est alors écrasée au
 * coffre : elle ne sert plus, même posée sur la VM.
 */
export async function upsertWindowsHost(
  deps: WindowsServiceDeps,
  input: UpsertWindowsHostRequest,
): Promise<WindowsHostView | ProviderRefusal> {
  const existing = deps.store.getWindowsHost(input.id)
  let fingerprint = existing?.fingerprint ?? null
  if (input.fingerprint !== undefined) {
    fingerprint = normalizeFingerprint(input.fingerprint)
    if (!fingerprint) {
      return {
        error: 'invalid_fingerprint',
        status: 400,
        detail: { reason: 'empreinte illisible : attendu « SHA256:… » (43 caractères), ou la ligne entière de ssh-keygen -lf' },
      }
    }
  }
  if (!fingerprint) {
    return {
      error: 'fingerprint_required',
      status: 400,
      detail: { reason: 'l\'empreinte d\'hôte est exigée à la déclaration : lis-la sur la console de la VM' },
    }
  }

  let publicKey = existing?.public_key ?? null
  if (!existing || input.new_key) {
    const pair = generateKeyPair(`midgaard-${input.id}`)
    // Le coffre d'abord : un échec ici laisse la déclaration précédente,
    // et sa clé, intactes.
    try {
      await deps.vault.set(await windowsKeyRef(deps.config.home, input.id), pair.privateKey)
    } catch (e) {
      return { error: 'vault_write_failed', status: 500, detail: { reason: (e as Error).message } }
    }
    publicKey = pair.publicKey
  }

  const host = deps.store.upsertWindowsHost({
    id: input.id,
    name: input.name ?? existing?.name ?? input.id,
    host: input.host,
    port: input.port,
    username: input.username,
    fingerprint,
    publicKey: publicKey!,
  })
  deps.log(
    `VM Windows « ${input.id} » ${existing ? 'mise à jour' : 'déclarée'} : ${input.username}@${input.host}:${input.port}, ` +
      `empreinte ${fingerprint}${!existing || input.new_key ? ', clé générée' : ''}`,
  )
  return windowsHostView(host)
}

/**
 * Teste une VM : joint l'hôte épinglé avec la clé du coffre et fait répondre
 * PowerShell. Le résultat est enregistré, réussi ou non.
 */
export async function testWindowsHost(
  deps: WindowsServiceDeps,
  id: string,
  signal?: AbortSignal,
): Promise<WindowsHostView | ProviderRefusal> {
  const host = deps.store.getWindowsHost(id)
  if (!host) return { error: 'windows_host_not_found', status: 404 }
  const at = () => new Date().toISOString()
  const finish = (test: WindowsTest): WindowsHostView => {
    deps.log(`VM Windows « ${id} » testée : ${test.ok ? 'réussi' : 'échec'} — ${test.detail}`)
    return windowsHostView(deps.store.recordWindowsTest(id, test) ?? host)
  }
  const failed = (detail: string, presented: string | null = null): WindowsHostView =>
    finish({ ok: false, detail, at: at(), latency_ms: null, powershell: null, os: null, presented_fingerprint: presented })

  const privateKey = await deps.vault.get(await windowsKeyRef(deps.config.home, id)).catch(() => null)
  if (!privateKey) return failed('clé absente du coffre : redéclare la VM avec une nouvelle clé (--new-key), puis pose-la')

  const started = Date.now()
  let session: RemoteSession
  try {
    session = await RemoteSession.open({
      host: host.host,
      port: host.port,
      username: host.username,
      privateKey,
      fingerprint: host.fingerprint,
      connectTimeoutMs: WINDOWS_TEST_CONNECT_MS,
    })
  } catch (e) {
    if (e instanceof RemoteError) {
      const why: Record<string, string> = {
        fingerprint_mismatch: `l'hôte présente l'empreinte ${e.presented}, pas celle épinglée (${host.fingerprint}) : rien n'a été envoyé`,
        auth_failed: `l'hôte refuse la clé de Midgaard pour ${host.username} : la clé publique est-elle posée sur la VM ?`,
        unreachable: `injoignable : ${host.host}:${host.port} (la VM est-elle allumée, sshd démarré ?)`,
        timeout: `aucune poignée de main SSH en ${WINDOWS_TEST_CONNECT_MS / 1000} s`,
        protocol: e.message,
      }
      return failed(why[e.kind] ?? e.message, e.presented)
    }
    return failed((e as Error).message)
  }
  try {
    const r = await session.run(powershellCommand(WINDOWS_TEST_SCRIPT), { timeoutMs: WINDOWS_TEST_RUN_MS, signal })
    const [powershell, os] = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    if (r.code !== 0 || !powershell) {
      const cause = r.timedOut ? 'délai écoulé' : r.cancelled ? 'test interrompu' : `code ${r.code}`
      return failed(`connexion établie, mais PowerShell n'a pas répondu (${cause}) : ${r.stderr.trim().slice(0, 300) || 'aucune sortie'}`)
    }
    return finish({
      ok: true,
      detail: `PowerShell ${powershell}${os ? ` sur ${os}` : ''}`,
      at: at(),
      latency_ms: Date.now() - started,
      powershell,
      os: os ?? null,
      presented_fingerprint: null,
    })
  } finally {
    session.close()
  }
}

/** Retire une VM et efface sa clé du coffre. */
export async function deleteWindowsHost(deps: WindowsServiceDeps, id: string): Promise<{ ok: true } | ProviderRefusal> {
  if (!deps.store.getWindowsHost(id)) return { error: 'windows_host_not_found', status: 404 }
  await deps.vault.delete(await windowsKeyRef(deps.config.home, id)).catch((e: Error) => {
    // Une clé qu'on n'arrive pas à effacer n'empêche pas de retirer la VM :
    // mieux vaut le signaler que bloquer l'humain.
    deps.log(`VM Windows « ${id} » : clé non effacée du coffre : ${e.message}`)
  })
  deps.store.deleteWindowsHost(id)
  deps.log(`VM Windows « ${id} » retirée, sa clé effacée du coffre`)
  return { ok: true }
}
