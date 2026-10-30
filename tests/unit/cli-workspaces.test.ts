/**
 * @file Ce que la CLI décide seule, sans daemon : lecture des arguments de
 * `harness exec`, et contrôles de `doctor` sur Git et la liste blanche.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { execAllowCheck, gitCheck, parseExecArgs } from '@midgaard/cli'

describe('parseExecArgs', () => {
  it('garde les options de la commande, qui viennent après le premier mot', () => {
    // Sans cette règle, `npx tsc --noEmit` perdrait son `--noEmit`.
    assert.deepEqual(parseExecArgs(['npx', 'tsc', '--noEmit']).argv, ['npx', 'tsc', '--noEmit'])
  })

  it('lit --yes et --dir avant la commande, et -- comme séparateur', () => {
    const r = parseExecArgs(['--yes', '--dir', '/depot', '--', 'npm', 'test', '--yes'])
    assert.equal(r.yes, true)
    assert.equal(r.dir, '/depot')
    assert.deepEqual(r.argv, ['npm', 'test', '--yes'], 'un --yes après la commande lui appartient')
  })

  it('ne confirme rien d\'office', () => {
    assert.equal(parseExecArgs(['npm', 'test']).yes, false)
  })
})

describe('gitCheck', () => {
  it('accepte 2.17 et plus, avertit en deçà ou en l\'absence de Git', () => {
    assert.equal(gitCheck('git version 2.54.0 (Apple Git-157)').level, 'ok')
    assert.equal(gitCheck('git version 2.17.1').level, 'ok')
    assert.equal(gitCheck('git version 2.16.6').level, 'warn')
    assert.equal(gitCheck('git version 1.9.0').level, 'warn')
    const absent = gitCheck(null)
    assert.equal(absent.level, 'warn', 'le Researcher se passe de Git : avertissement, pas échec')
    assert.match(absent.fix ?? '', /2\.17/)
  })
})

describe('execAllowCheck', () => {
  it('est vert quand chaque commande attend un humain', () => {
    assert.equal(execAllowCheck([], [], '/depot').level, 'ok')
  })

  it('avertit dès qu\'une commande passe sans approbation, et dit pourquoi', () => {
    const c = execAllowCheck([['npm', 'test']], [['npx', 'tsc', '--noEmit']], '/depot')
    assert.equal(c.level, 'warn')
    assert.match(c.detail, /npm test \(tous dépôts\).*npx tsc --noEmit/)
    assert.match(c.fix ?? '', /ce que l'agent a écrit/)
  })
})
