/**
 * @file Le paquet `remote` (Slice 9, étape 5.1) face à un hôte SSH factice.
 *
 * Ce qui est éprouvé : l'empreinte lue comme l'humain la recopie ; une clé
 * générée qui s'authentifie ; **aucune tentative d'authentification** quand
 * l'hôte présente une autre clé (compté côté hôte) ; les refus nommés (clé
 * refusée, hôte injoignable) ; une commande — sortie, erreur, code, sortie
 * bornée, délai, annulation, canal fermé côté hôte ; la copie d'un arbre par
 * SFTP, liens écartés. Ce que Windows fait d'une session coupée n'est pas
 * ici : il faut un vrai Windows (sous-étape 5.4).
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  RemoteError,
  RemoteSession,
  fingerprintOfPublicKey,
  generateKeyPair,
  normalizeFingerprint,
  type RemoteTarget,
} from '@midgaard/remote'
import { startFakeSshServer, type FakeSshServer } from '../fake-ssh-server.ts'

/**
 * Une clé publique fixe et l'empreinte qu'en donne `ssh-keygen -lf`, relevée
 * le 2026-11-07 avec OpenSSH 10.3 : le calcul doit tomber juste sans dépendre
 * de l'outil sur le poste de test.
 */
const KNOWN_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJBcD/NAySuddGUWsPO/KpO85LjIL0O5lixKsRjbO0yK test'
/** Relevée par `ssh-keygen -lf` sur {@link KNOWN_KEY}. */
const KNOWN_FP = 'SHA256:u69lh1Bfp8f+5ZprLkeJC5KFo5xCDWa6llexR9QkiU4'

describe('empreintes', () => {
  it('lit ce que l\'humain recopie de ssh-keygen -lf, ou la forme nue', () => {
    const fp = 'SHA256:Kvf3tuIDBIe8bJJHNUJx8NAP9Y1Dk3JlHE2haD46qLI'
    assert.equal(normalizeFingerprint(`256 ${fp} root@vm (ED25519)`), fp)
    assert.equal(normalizeFingerprint(`  ${fp}  `), fp)
    assert.equal(normalizeFingerprint(`${fp}=`), fp, 'un remplissage recopié est retiré')
  })

  it('refuse ce qui n\'épingle rien', () => {
    assert.equal(normalizeFingerprint('MD5:aa:bb:cc'), null)
    assert.equal(normalizeFingerprint('SHA256:trop-court'), null)
    assert.equal(normalizeFingerprint(''), null)
  })

  it('calcule l\'empreinte comme ssh-keygen', () => {
    assert.equal(fingerprintOfPublicKey(KNOWN_KEY), KNOWN_FP)
  })

  it('génère une clé ed25519 dédiée, commentée', () => {
    const pair = generateKeyPair('midgaard-vm-test')
    assert.match(pair.publicKey, /^ssh-ed25519 [A-Za-z0-9+/=]+ midgaard-vm-test$/)
    assert.match(pair.privateKey, /^-----BEGIN OPENSSH PRIVATE KEY-----/)
    assert.match(fingerprintOfPublicKey(pair.publicKey), /^SHA256:[A-Za-z0-9+/]{43}$/)
  })
})

describe('une session vers un hôte épinglé', () => {
  let server: FakeSshServer
  let root: string
  let local: string
  const pair = generateKeyPair('midgaard-test')
  let target: RemoteTarget

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'midgaard-ssh-hote-'))
    local = mkdtempSync(join(tmpdir(), 'midgaard-ssh-local-'))
    server = await startFakeSshServer(pair.publicKey, root)
    target = {
      host: '127.0.0.1', port: server.port, username: 'tester', privateKey: pair.privateKey,
      fingerprint: fingerprintOfPublicKey(server.hostPublicKey),
    }
  })
  after(async () => {
    await server.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(local, { recursive: true, force: true })
  })

  it('refuse un hôte qui présente une autre clé, sans jamais s\'authentifier', async () => {
    const before = server.authAttempts
    const other = fingerprintOfPublicKey(generateKeyPair('autre').publicKey)
    const e = await RemoteSession.open({ ...target, fingerprint: other }).catch((err: unknown) => err)
    // Une session ouverte à tort se ferme, sans quoi le test resterait
    // suspendu au lieu d'échouer — vu en retirant la comparaison.
    if (e instanceof RemoteSession) e.close()
    assert.ok(e instanceof RemoteError, 'l\'hôte à la mauvaise empreinte a été accepté')
    assert.equal(e.kind, 'fingerprint_mismatch')
    assert.equal(e.presented, target.fingerprint, 'le refus dit l\'empreinte vue')
    assert.match(e.message, /Nothing was sent/)
    assert.equal(server.authAttempts, before, 'aucune tentative d\'authentification n\'a atteint l\'hôte')
  })

  it('nomme une clé refusée et un hôte injoignable', async () => {
    const stranger = generateKeyPair('inconnue')
    await assert.rejects(RemoteSession.open({ ...target, privateKey: stranger.privateKey }), (e: unknown) =>
      e instanceof RemoteError && e.kind === 'auth_failed')
    await assert.rejects(RemoteSession.open({ ...target, port: 1 }), (e: unknown) =>
      e instanceof RemoteError && e.kind === 'unreachable')
  })

  it('lance une commande : sortie, erreur, code, et chaque morceau en direct', async () => {
    const session = await RemoteSession.open(target)
    try {
      const seen: string[] = []
      const ok = await session.run('echo bonjour', { timeoutMs: 5_000, onOutput: (s, c) => seen.push(`${s}:${c}`) })
      assert.equal(ok.code, 0)
      assert.equal(ok.stdout, 'bonjour\n')
      assert.deepEqual(seen, ['stdout:bonjour\n'])
      const err = await session.run('stderr attention', { timeoutMs: 5_000 })
      assert.equal(err.stderr, 'attention\n')
      assert.equal((await session.run('exit 3', { timeoutMs: 5_000 })).code, 3)
    } finally {
      session.close()
    }
  })

  it('borne la sortie en gardant début et fin, et compte tout', async () => {
    const session = await RemoteSession.open(target)
    try {
      const r = await session.run('flood 200000', { timeoutMs: 5_000 })
      assert.equal(r.stdoutBytes, 200_000)
      assert.match(r.stdout, /\[… \d+ bytes omitted …\]/)
      assert.ok(r.stdout.length < 50_000)
    } finally {
      session.close()
    }
  })

  it('ferme le canal au délai et à l\'annulation, et le dit', async () => {
    const session = await RemoteSession.open(target)
    try {
      const early = server.closedEarly
      const slow = await session.run('sleep 5000', { timeoutMs: 200 })
      assert.equal(slow.timedOut, true)
      assert.equal(slow.code, null)
      const abort = new AbortController()
      setTimeout(() => abort.abort(), 200)
      const cancelled = await session.run('sleep 5000', { timeoutMs: 10_000, signal: abort.signal })
      assert.equal(cancelled.cancelled, true)
      // L'hôte a vu ses deux canaux fermés avant leur fin : c'est tout ce que
      // la session promet. Le sort de ses processus est l'affaire de 5.4.
      await new Promise((r) => setTimeout(r, 100))
      assert.equal(server.closedEarly, early + 2)
    } finally {
      session.close()
    }
  })

  it('copie un arbre par SFTP, sans jamais suivre un lien', async () => {
    mkdirSync(join(local, 'src', 'rules'), { recursive: true })
    writeFileSync(join(local, 'src', 'rules', 'a.yml'), 'title: a\n')
    writeFileSync(join(local, 'run-tests.ps1'), 'Invoke-Pester\n')
    mkdirSync(join(local, '.git'))
    writeFileSync(join(local, '.git', 'config'), '[core]\n')
    const secret = mkdtempSync(join(tmpdir(), 'midgaard-ssh-secret-'))
    writeFileSync(join(secret, 'id_ed25519'), 'PRIVATE')
    const linked = process.platform === 'win32' ? false : (symlinkSync(secret, join(local, 'lien')), true)

    const session = await RemoteSession.open(target)
    try {
      const summary = await session.uploadTree(local, '/C:/midgaard/tache', (rel) => (rel === '.git' ? 'never copied: .git' : null))
      assert.equal(summary.files, 2)
      assert.equal(readFileSync(join(root, 'C:', 'midgaard', 'tache', 'src', 'rules', 'a.yml'), 'utf8'), 'title: a\n')
      assert.equal(existsSync(join(root, 'C:', 'midgaard', 'tache', '.git')), false)
      assert.ok(summary.skipped.some((s) => s.path === '.git'))
      if (linked) {
        assert.ok(summary.skipped.some((s) => s.path === 'lien' && /symbolic link/.test(s.reason)))
        assert.equal(existsSync(join(root, 'C:', 'midgaard', 'tache', 'lien')), false, 'le lien n\'est pas suivi')
      }
    } finally {
      session.close()
      rmSync(secret, { recursive: true, force: true })
    }
  })
})
