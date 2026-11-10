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
 *
 * Et le dossier d'une tâche (étape 5.3b) : son chemin sous le dossier
 * personnel, un identifiant qui n'est pas un UUID refusé ; la recopie qui
 * fait disparaître un fichier périmé ; un effacement hors de la racine
 * permise refusé **sans rien envoyer** (compté par l'hôte) ; un lien retiré
 * lui-même, jamais traversé — le dossier qu'il désigne reste intact.
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
  isStrictlyUnder,
  isUsableKeyPair,
  normalizeFingerprint,
  remoteTaskDir,
  type RemoteTarget,
} from '@midgaard/remote'
import ssh2 from 'ssh2'
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

  it('écarte une paire mal formée par ssh2, et n\'en rend jamais une', () => {
    // ssh2 1.17 rend une paire sur 256 mal formée (premier octet nul retiré) :
    // on en provoque une pour éprouver le contrôle, puis on tire assez de
    // paires pour qu'une seule, sans contrôle, échoue presque sûrement.
    let bad: { privateKey: string; publicKey: string } | null = null
    for (let i = 0; i < 20_000 && !bad; i++) {
      const raw = ssh2.utils.generateKeyPairSync('ed25519', { comment: 'x' })
      const pair = { privateKey: raw.private, publicKey: raw.public.trim() }
      if (!isUsableKeyPair(pair)) bad = pair
    }
    assert.ok(bad, 'aucune paire mal formée en 20 000 tirages : le défaut de ssh2 a disparu ?')
    assert.match(bad.publicKey, /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAH/, 'la clé annonce 31 octets au lieu de 32')
    for (let i = 0; i < 2_000; i++) assert.ok(isUsableKeyPair(generateKeyPair('midgaard-test')))
  })

  it('génère une clé ed25519 dédiée, commentée', () => {
    const pair = generateKeyPair('midgaard-vm-test')
    assert.match(pair.publicKey, /^ssh-ed25519 [A-Za-z0-9+/=]+ midgaard-vm-test$/)
    assert.match(pair.privateKey, /^-----BEGIN OPENSSH PRIVATE KEY-----/)
    assert.match(fingerprintOfPublicKey(pair.publicKey), /^SHA256:[A-Za-z0-9+/]{43}$/)
  })
})

describe('le chemin du dossier d\'une tâche', () => {
  const id = '3f2a8c1e-5b7d-4e9f-a1c3-0d2e4f6a8b9c'

  it('vit sous le dossier personnel, dans midgaard/tasks', () => {
    assert.deepEqual(remoteTaskDir('/C:/Users/analyste', id), {
      base: '/C:/Users/analyste/midgaard',
      tasks: '/C:/Users/analyste/midgaard/tasks',
      dir: `/C:/Users/analyste/midgaard/tasks/${id}`,
      work: `/C:/Users/analyste/midgaard/tasks/${id}/work`,
    })
  })

  it('refuse un identifiant qui n\'est pas un UUID, et un dossier personnel relatif', () => {
    for (const bad of ['../../Windows', `${id}/..`, 'C:', '', id.toUpperCase()]) {
      assert.throws(() => remoteTaskDir('/C:/Users/analyste', bad), (e: unknown) => e instanceof RemoteError, bad)
    }
    assert.throws(() => remoteTaskDir('C:/Users/analyste', id), RemoteError)
  })

  it('« strictement sous » : jamais la racine elle-même, ni un voisin au même préfixe', () => {
    assert.equal(isStrictlyUnder('/C:/U/midgaard/tasks/x', '/C:/U/midgaard'), true)
    assert.equal(isStrictlyUnder('/C:/U/MIDGAARD/tasks', '/C:/U/midgaard'), true, 'Windows ignore la casse')
    assert.equal(isStrictlyUnder('/C:/U/midgaard', '/C:/U/midgaard'), false)
    assert.equal(isStrictlyUnder('/C:/U/midgaard/', '/C:/U/midgaard'), false)
    assert.equal(isStrictlyUnder('/C:/U/midgaard-old/x', '/C:/U/midgaard'), false)
    assert.equal(isStrictlyUnder('/C:/U/midgaard/../Windows', '/C:/U/midgaard'), false)
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
      assert.equal(readFileSync(join(root, 'C', 'midgaard', 'tache', 'src', 'rules', 'a.yml'), 'utf8'), 'title: a\n')
      assert.equal(existsSync(join(root, 'C', 'midgaard', 'tache', '.git')), false)
      assert.ok(summary.skipped.some((s) => s.path === '.git'))
      if (linked) {
        assert.ok(summary.skipped.some((s) => s.path === 'lien' && /symbolic link/.test(s.reason)))
        assert.equal(existsSync(join(root, 'C', 'midgaard', 'tache', 'lien')), false, 'le lien n\'est pas suivi')
      }
    } finally {
      session.close()
      rmSync(secret, { recursive: true, force: true })
    }
  })

  it('lit le dossier personnel du compte', async () => {
    const session = await RemoteSession.open(target)
    try {
      assert.equal(await session.homeDir(), '/C:/Users/tester')
    } finally {
      session.close()
    }
  })

  it('recopie le worktree : un fichier retiré en local disparaît de la VM', async () => {
    const tree = mkdtempSync(join(tmpdir(), 'midgaard-ssh-arbre-'))
    writeFileSync(join(tree, 'keep.ps1'), 'Get-Date\n')
    writeFileSync(join(tree, 'stale.ps1'), 'old\n')
    const session = await RemoteSession.open(target)
    try {
      const where = remoteTaskDir(await session.homeDir(), '11111111-2222-4333-8444-555555555555')
      const first = await session.replaceTree(tree, where.work, where.base)
      assert.equal(first.files, 2)
      assert.equal(first.removedBefore.removed, 0, 'rien à effacer la première fois')
      // Ce qu'une commande précédente aurait laissé, et un fichier retiré du worktree.
      const remoteWork = join(root, 'C', 'Users', 'tester', 'midgaard', 'tasks', '11111111-2222-4333-8444-555555555555', 'work')
      mkdirSync(join(remoteWork, 'out'))
      writeFileSync(join(remoteWork, 'out', 'report.txt'), 'x')
      rmSync(join(tree, 'stale.ps1'))
      const second = await session.replaceTree(tree, where.work, where.base)
      assert.equal(second.files, 1)
      assert.equal(existsSync(join(remoteWork, 'keep.ps1')), true)
      assert.equal(existsSync(join(remoteWork, 'stale.ps1')), false, 'le fichier périmé a disparu')
      assert.equal(existsSync(join(remoteWork, 'out')), false, 'ce qu\'une commande a laissé aussi')
      // Le dossier de la tâche s'efface en entier à la fin.
      const end = await session.removeTree(where.dir, where.base)
      assert.ok(end.removed >= 2)
      assert.equal(existsSync(join(remoteWork, '..')), false)
      assert.equal(existsSync(join(root, 'C', 'Users', 'tester', 'midgaard', 'tasks')), true, 'le dossier des tâches reste')
    } finally {
      session.close()
      rmSync(tree, { recursive: true, force: true })
    }
  })

  it('refuse d\'effacer hors de la racine permise, sans rien envoyer', async () => {
    const session = await RemoteSession.open(target)
    try {
      const home = await session.homeDir()
      const where = remoteTaskDir(home, '22222222-2222-4333-8444-555555555555')
      mkdirSync(join(root, 'C', 'Users', 'tester', 'Documents'), { recursive: true })
      writeFileSync(join(root, 'C', 'Users', 'tester', 'Documents', 'precieux.txt'), 'x')
      const removed = server.removed.length
      for (const [dir, allowed] of [
        [`${home}/Documents`, where.base],
        [where.base, where.base],
        [`${where.base}/../Documents`, where.base],
        [`${home}/midgaard-old`, where.base],
      ] as const) {
        await assert.rejects(session.removeTree(dir, allowed), (e: unknown) => e instanceof RemoteError && /Nothing was removed/.test(e.message), dir)
      }
      assert.equal(server.removed.length, removed, 'aucun effacement n\'a atteint l\'hôte')
      assert.equal(existsSync(join(root, 'C', 'Users', 'tester', 'Documents', 'precieux.txt')), true)
    } finally {
      session.close()
    }
  })

  // Un lien symbolique se crée sans droits particuliers sous macOS et Linux ;
  // sous Windows il en faut, et ce que le SFTP de Win32-OpenSSH dit d'une
  // jonction se constate sur un vrai Windows (5.5), pas avec cet hôte.
  it('retire un lien lui-même, sans jamais le traverser', { skip: process.platform === 'win32' && 'liens symboliques : 5.5, sur un vrai Windows' }, async () => {
    const outside = join(root, 'C', 'Users', 'tester', 'Precious')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'a.txt'), 'garde-moi')
    const session = await RemoteSession.open(target)
    try {
      const where = remoteTaskDir(await session.homeDir(), '33333333-2222-4333-8444-555555555555')
      const local = join(root, 'C', 'Users', 'tester', 'midgaard', 'tasks', '33333333-2222-4333-8444-555555555555', 'work')
      mkdirSync(local, { recursive: true })
      symlinkSync(outside, join(local, 'vers-precious'))
      writeFileSync(join(local, 'f.txt'), 'x')
      const summary = await session.removeTree(where.dir, where.base)
      assert.deepEqual(summary.links, ['work/vers-precious'], 'le lien est nommé')
      assert.equal(readFileSync(join(outside, 'a.txt'), 'utf8'), 'garde-moi', 'le dossier désigné est intact')
      assert.equal(existsSync(join(local, '..')), false, 'le dossier de la tâche est parti')

      // Un lien posé **à la place** du dossier des tâches : refusé avant tout effacement.
      const tasks = join(root, 'C', 'Users', 'tester', 'midgaard', 'tasks')
      rmSync(tasks, { recursive: true, force: true })
      symlinkSync(outside, tasks)
      const removed = server.removed.length
      await assert.rejects(session.removeTree(`${where.tasks}/a.txt`, where.base), (e: unknown) =>
        e instanceof RemoteError && /not a plain directory/.test(e.message))
      assert.equal(server.removed.length, removed)
      assert.equal(readFileSync(join(outside, 'a.txt'), 'utf8'), 'garde-moi')
      rmSync(tasks)
    } finally {
      session.close()
    }
  })
})
