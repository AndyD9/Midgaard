/**
 * @file L'installation d'un daemon, et ce que `doctor` en dit.
 *
 * Décision de la Slice 4, étape 6 : un serveur MCP remplace le daemon d'une
 * autre installation s'il est oisif, et s'en sert sinon. Ce qui suit prouve
 * l'identité sur laquelle repose la comparaison ; le remplacement lui-même est
 * éprouvé de bout en bout par `tests/package.ts` (K6), avec un vrai paquet
 * installé et un vrai daemon des sources.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { PROTOCOL_VERSION, type Health } from '@midgaard/contracts'
import { installation, keyCommand, sameInstallation } from '@midgaard/daemon'
import { daemonCheck } from '@midgaard/cli'

describe('installation', () => {
  it('désigne le paquet @midgaard/daemon et sa version', () => {
    const mine = installation()
    const manifest = JSON.parse(readFileSync(join(mine.dir, 'package.json'), 'utf8')) as { name: string; version: string }
    assert.equal(manifest.name, '@midgaard/daemon')
    assert.equal(mine.version, manifest.version)
  })

  it('distingue un autre dossier comme une autre version', () => {
    const mine = installation()
    assert.equal(sameInstallation(mine, { ...mine }), true)
    assert.equal(sameInstallation(mine, { ...mine, dir: `${mine.dir}-autre` }), false)
    assert.equal(sameInstallation(mine, { ...mine, version: '9.9.9' }), false)
  })
})

describe('daemonCheck', () => {
  const mine = { dir: '/paquet/node_modules/@midgaard/daemon', version: '0.2.0' }
  const health = (over: Partial<Health>): Health =>
    ({ pid: 42, protocol: PROTOCOL_VERSION, install: mine, ...over }) as Health

  it('est vert pour un daemon de cette installation', () => {
    const c = daemonCheck(health({}), mine)
    assert.equal(c.level, 'ok')
    assert.match(c.detail, /v0\.2\.0/)
  })

  it('nomme l\'autre installation, et dit ce que fera le prochain appel', () => {
    const c = daemonCheck(health({ install: { dir: '/depot/packages/daemon', version: '0.1.0' } }), mine)
    assert.equal(c.level, 'warn')
    assert.match(c.detail, /autre installation : \/depot\/packages\/daemon v0\.1\.0/)
    assert.match(c.fix ?? '', /s'il n'a aucune tâche active/)
  })

  it('traite d\'abord un autre protocole, qui se remplace sans condition', () => {
    const c = daemonCheck(health({ protocol: PROTOCOL_VERSION - 1 }), mine)
    assert.equal(c.level, 'warn')
    assert.match(c.fix ?? '', /remplacera automatiquement/)
  })
})

describe('conseil de clé du daemon', () => {
  // Il disait `harness providers set venice`, que la CLI refuse sans `--model`
  // et que les sources ne savent pas lancer (Slice 4, étape 7). On vérifie la
  // forme depuis les sources (c'est d'ici que tournent les tests), et que la
  // déclaration entière est redite, `--base-url` compris quand il y en a un.
  it('redit toute la déclaration, sous la forme que les sources savent lancer', () => {
    assert.equal(
      keyCommand({ id: 'venice', preset: 'venice', default_model: 'deepseek-v4-flash-0731', base_url: null }),
      'npm run harness -- providers add venice --preset venice --model deepseek-v4-flash-0731',
    )
    assert.equal(
      keyCommand({ id: 'local', preset: 'custom', default_model: 'qwen', base_url: 'http://127.0.0.1:8080/v1' }),
      'npm run harness -- providers add local --preset custom --model qwen --base-url http://127.0.0.1:8080/v1',
    )
  })
})
