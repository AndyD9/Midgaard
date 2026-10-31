/**
 * @file Les contrôles de la publication npm (`scripts/release.ts`).
 *
 * La comparaison d'après publication repose sur une affirmation : l'empreinte
 * que calcule le script est **celle que npm écrit** dans `dist.integrity`. Une
 * formule fausse ferait échouer chaque publication réussie — ou, pire, passer
 * une comparaison qui ne compare rien. On la confronte donc à `npm pack`, qui
 * calcule la même empreinte que le registre, sur un vrai tarball.
 *
 * Le reste de `check` (registre, branche) s'éprouve par la répétition générale
 * du workflow : il interroge le vrai registre et le vrai dépôt.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { atLeast, integrity } from '../../scripts/release.ts'

describe('publication', () => {
  it("calcule l'empreinte que npm attribue au tarball", () => {
    const dir = mkdtempSync(join(tmpdir(), 'midgaard-release-'))
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'empreinte', version: '1.0.0' }))
      writeFileSync(join(dir, 'index.js'), 'export {}\n')
      const [packed] = JSON.parse(
        execFileSync('npm', ['pack', '--json', '--pack-destination', dir], {
          cwd: dir,
          encoding: 'utf8',
          shell: process.platform === 'win32',
        }),
      ) as { filename: string; integrity: string }[]
      assert.equal(integrity(join(dir, packed!.filename)), packed!.integrity)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('compare les versions de npm composante par composante', () => {
    const min = [11, 5, 1] as const
    assert.equal(atLeast('11.5.1', min), true)
    assert.equal(atLeast('11.16.0', min), true, '16 > 5 : une comparaison de chaînes dirait le contraire')
    assert.equal(atLeast('12.0.0', min), true)
    assert.equal(atLeast('11.5.0', min), false)
    assert.equal(atLeast('10.99.99', min), false)
    assert.equal(atLeast('11.5.1-pre.0', min), true)
  })
})
