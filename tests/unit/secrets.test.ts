/**
 * @file Conformité des coffres : la même batterie, passée au coffre **réel de
 * la machine qui exécute ce test**, et au repli fichier partout.
 *
 * Pourquoi ce fichier existe. La Slice 2 livrait quatre coffres et n'en testait
 * aucun : toutes les suites posent `MIDGAARD_VAULT=file` — à raison, puisqu'un
 * coffre système est par utilisateur — et le trousseau n'était donc jamais
 * touché. DPAPI et libsecret étaient « écrits d'après leur documentation », ce
 * que la Slice 2 reconnaissait comme sa dette n° 3.
 *
 * Écrire la batterie a suffi à en trouver deux, avant même de la lancer :
 *
 *  - **DPAPI rangeait toutes les références dans un seul fichier.** La
 *    référence voyageait par `process.env`, que `run` ne transmet pas ; le
 *    script PowerShell lisait `$null` et composait toujours le même chemin.
 *    Une clé déposée écrasait la précédente, et la relecture rendait la
 *    dernière — sans erreur. C'est le cas « deux références ne se mélangent
 *    pas » ci-dessous qui le prend.
 *  - **libsecret se déclarait disponible sans bus de session.** `secret-tool`
 *    sort en 1 aussi bien pour « absent » que pour « bus injoignable » ; la
 *    sonde acceptait les deux.
 *
 * Ce que ce fichier ne peut pas faire seul : prouver Windows et Linux depuis un
 * Mac. Il est donc écrit pour **tourner tel quel sur les trois**, et
 * `.github/workflows/vault.yml` l'y lance. La batterie ne connaît aucun coffre
 * en particulier : elle ne parle qu'à l'interface `SecretVault`.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import {
  VAULT_ENV,
  VAULT_IDS,
  fileVault,
  libsecret,
  macosKeychain,
  normalizeRef,
  openVault,
  resolveApiKey,
  secretsDir,
  windowsDpapi,
  type SecretVault,
} from '@midgaard/secrets'
import { vaultAdvice } from '@midgaard/cli'

/**
 * Préfixe des références de ce test.
 *
 * Un coffre système est **partagé avec le harness réel de l'utilisateur** : le
 * test ne doit jamais écrire sous `provider.venice`, ni laisser derrière lui de
 * quoi gêner un autre exécution. D'où un préfixe unique par processus, et une
 * suppression systématique en fin de course.
 */
const PREFIX = `test.conformance.${process.pid}.${Math.random().toString(36).slice(2, 8)}`

/** Un secret non-ASCII : c'est lui qui déclenche le rendu hexadécimal de `security`. */
const UNICODE_SECRET = 'clé-de-test-日本語-🔑-ß'

/**
 * Passe la batterie de conformité à un coffre.
 *
 * Les cas sont ceux qu'un coffre peut rater **en silence** : rendre le secret
 * d'une autre référence, corrompre un caractère non anglais, garder une valeur
 * remplacée. Un coffre qui lève est facile à repérer ; un coffre qui ment ne
 * l'est pas, et c'est la seule raison d'être de ce fichier.
 *
 * @param vault coffre à éprouver, déjà connu disponible
 * @param label ce qui apparaît dans la sortie du test
 */
function conformance(vault: SecretVault, label: string): void {
  describe(label, () => {
    const a = `${PREFIX}.a`
    const b = `${PREFIX}.b`

    // Quoi qu'il arrive au-dessus, on ne laisse rien dans le trousseau de
    // l'utilisateur : un test qui échoue ne doit pas coûter un nettoyage manuel.
    after(async () => {
      for (const ref of [a, b]) await vault.delete(ref).catch(() => {})
    })

    it('rend null sur une référence absente, sans lever', async () => {
      assert.equal(await vault.get(`${PREFIX}.jamais-deposee`), null)
    })

    it('rend exactement ce qui a été déposé', async () => {
      await vault.set(a, 'sk-ascii-0123456789')
      assert.equal(await vault.get(a), 'sk-ascii-0123456789')
    })

    it('rend un secret non-ASCII sans le corrompre', async () => {
      // Le piège documenté dans `vaults.ts` : `security find-generic-password -w`
      // rend de l'hexadécimal dès qu'un octet n'est pas de l'ASCII imprimable,
      // sans le signaler. Si l'encodage `mg1:` tombe, c'est ici que ça se voit.
      await vault.set(a, UNICODE_SECRET)
      assert.equal(await vault.get(a), UNICODE_SECRET)
    })

    it('remplace la valeur d’une référence déjà écrite', async () => {
      await vault.set(a, 'premiere')
      await vault.set(a, 'seconde')
      assert.equal(await vault.get(a), 'seconde')
    })

    it('ne mélange pas deux références', async () => {
      // Le cas qui a pris DPAPI. Un coffre qui range tout au même endroit passe
      // tous les cas ci-dessus : il ne se trahit qu'avec deux références vivantes
      // en même temps.
      await vault.set(a, 'valeur-de-a')
      await vault.set(b, 'valeur-de-b')
      assert.equal(await vault.get(a), 'valeur-de-a')
      assert.equal(await vault.get(b), 'valeur-de-b')
    })

    it('supprime, et la suppression d’un absent n’est pas une erreur', async () => {
      await vault.set(a, 'a-supprimer')
      await vault.delete(a)
      assert.equal(await vault.get(a), null)
      await vault.delete(a) // deux fois : l'absence est un état, pas une panne
    })
  })
}

// --- le repli fichier, partout ---------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'midgaard-vault-'))
after(() => rmSync(dir, { recursive: true, force: true }))

conformance(fileVault(dir), 'repli fichier')

describe('repli fichier : ce qu’il promet en plus', () => {
  it('annonce qu’il ne protège rien', () => {
    assert.equal(fileVault(dir).osBacked, false)
  })

  it('écrit en 0600 dans un dossier 0700, y compris sur un fichier préexistant', async (t) => {
    if (process.platform === 'win32') return t.skip('les bits POSIX n’ont pas cours sous Windows')
    const v = fileVault(dir)
    const ref = `${PREFIX}.perms`
    await v.set(ref, 'x')
    // Deux fois : `writeFileSync` n'applique `mode` qu'à la création, et c'est
    // le `chmod` explicite de `fileVault` qui rattrape un fichier déjà là.
    await v.set(ref, 'y')
    assert.equal(statSync(join(dir, ref)).mode & 0o777, 0o600)
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    await v.delete(ref)
  })
})

// --- le coffre système de cette machine, quel qu’il soit --------------------

/**
 * Trouve le coffre système utilisable ici.
 *
 * On interroge les trois plutôt que de choisir d'après `process.platform` :
 * c'est la disponibilité **mesurée** qui compte, et c'est exactement ce que
 * fait `openVault`.
 */
async function systemVault(): Promise<SecretVault | null> {
  for (const v of [macosKeychain, windowsDpapi, libsecret]) {
    if (await v.available()) return v
  }
  return null
}

const system = await systemVault()

// Le message de saut est une information, pas un aveu : sur un serveur sans
// trousseau, l'absence de coffre système est le comportement attendu, et la CI
// a un poste dédié qui vérifie précisément ce cas.
describe(
  `coffre système (${system ? system.id : 'aucun sur cette machine'})`,
  { skip: system ? false : `aucun coffre système disponible sur ${process.platform}` },
  () => {
    conformance(system!, `conformité de ${system?.label}`)

    it('se déclare protégé par le système', () => {
      assert.equal(system!.osBacked, true)
    })
  },
)

// --- ce que la CI exige d’avoir réellement exercé ---------------------------

/**
 * Coffre que l'environnement **exige** de voir retenu, ou `undefined`.
 *
 * Sans cela, un vert de CI ne voudrait rien dire : le poste Linux sans
 * trousseau et le poste Linux avec trousseau sauteraient tous deux la batterie
 * système et passeraient au vert sans avoir rien éprouvé. Chaque poste de
 * `.github/workflows/vault.yml` nomme donc le coffre qu'il prétend prouver, et
 * ce cas échoue si ce n'est pas celui-là.
 *
 * C'est l'invariant « ne rien décrire qui n'existe pas » appliqué à la CI : une
 * suite qui saute doit le dire, pas ressembler à une suite qui réussit.
 */
const REQUIRED = process.env.MIDGAARD_REQUIRE_VAULT?.trim()

describe(
  'coffre exigé par MIDGAARD_REQUIRE_VAULT',
  { skip: REQUIRED ? false : 'aucun coffre exigé : exécution locale' },
  () => {
    it(`openVault retient bien « ${REQUIRED} » sur cette machine`, async () => {
      const v = await openVault({ home: dir }, {})
      assert.equal(
        v.id,
        REQUIRED,
        `ce poste doit prouver « ${REQUIRED} » ; il a retenu « ${v.id} ». ` +
          `Un saut silencieux passerait au vert sans rien avoir éprouvé.`,
      )
    })
  },
)

// --- normalizeRef : interdire plutôt qu’échapper ----------------------------

describe('normalizeRef', () => {
  it('laisse intacte une référence déjà saine', () => {
    assert.equal(normalizeRef('provider.venice'), 'provider.venice')
  })

  it('neutralise ce qui pourrait sortir d’un argument ou d’un nom de fichier', () => {
    for (const [input, expected] of [
      ['../../etc/passwd', 'etc-passwd'],
      ['a b;rm -rf /', 'a-b-rm--rf--'],
      ['Provider.VENICE', 'provider.venice'],
      ['$(whoami)', 'whoami-'],
    ] as const) {
      assert.equal(normalizeRef(input), expected, `pour ${JSON.stringify(input)}`)
    }
  })

  it('refuse une référence qui ne laisse rien d’utilisable', () => {
    assert.throws(() => normalizeRef('///'), /inutilisable/)
    assert.throws(() => normalizeRef('   '), /inutilisable/)
  })

  it('borne la longueur, parce qu’elle finit en nom de fichier', () => {
    assert.equal(normalizeRef('a'.repeat(500)).length, 120)
  })
})

// --- openVault : le choix, et le refus d’un choix impossible ----------------

describe('openVault', () => {
  const config = { home: dir }

  it('rend le repli fichier quand il est demandé', async () => {
    const v = await openVault(config, { [VAULT_ENV]: 'file' })
    assert.equal(v.id, 'file')
  })

  it('range le repli sous le dossier runtime', () => {
    assert.equal(secretsDir(config), join(dir, 'secrets'))
  })

  it('refuse un identifiant de coffre inconnu, en listant les bons', async () => {
    await assert.rejects(openVault(config, { [VAULT_ENV]: 'keychain' }), (e: Error) => {
      assert.match(e.message, /inconnu/)
      for (const id of VAULT_IDS) assert.ok(e.message.includes(id), `${id} devrait être proposé`)
      return true
    })
  })

  it('refuse un coffre forcé mais indisponible, plutôt que de le contourner', async () => {
    // Un coffre forcé qui ne répond pas doit lever : ranger la clé ailleurs en
    // silence serait exactement ce que l'utilisateur a voulu empêcher.
    const absent = (['macos-keychain', 'windows-dpapi', 'libsecret'] as const).find(
      (id) => id !== system?.id,
    )!
    await assert.rejects(openVault(config, { [VAULT_ENV]: absent }), /indisponible/)
  })

  it('rend toujours un coffre, même sans aucun coffre système', async () => {
    const v = await openVault(config, {})
    assert.equal(v.id, system ? system.id : 'file')
  })
})

// --- resolveApiKey : le coffre d’abord, l’environnement en dépannage --------

describe('resolveApiKey', () => {
  const v = fileVault(dir)
  const ref = `${PREFIX}.resolve`
  after(async () => await v.delete(ref))

  it('préfère le coffre à l’environnement, et dit d’où vient la clé', async () => {
    await v.set(ref, 'depuis-le-coffre')
    assert.deepEqual(await resolveApiKey(v, ref, 'X_KEY', { X_KEY: 'depuis-env' }), {
      key: 'depuis-le-coffre',
      source: 'vault',
    })
  })

  it('retombe sur l’environnement, en le signalant comme tel', async () => {
    assert.deepEqual(await resolveApiKey(v, `${PREFIX}.absente`, 'X_KEY', { X_KEY: 'depuis-env' }), {
      key: 'depuis-env',
      source: 'env',
    })
  })

  it('rend null quand aucune source n’a de clé', async () => {
    assert.equal(await resolveApiKey(v, null, 'X_KEY', {}), null)
  })
})

// --- vaultAdvice : un conseil qui mène à une manette atteignable ------------

describe('vaultAdvice', () => {
  it('ne propose rien à installer quand le repli a été demandé', () => {
    const advice = vaultAdvice('linux', { [VAULT_ENV]: 'file' })
    assert.match(advice, new RegExp(`${VAULT_ENV}=file`))
    assert.doesNotMatch(advice, /libsecret/, 'rien à installer : le repli est un choix')
  })

  it('ne propose libsecret que là où il s’installe', () => {
    assert.match(vaultAdvice('linux', {}), /libsecret/)
    assert.doesNotMatch(vaultAdvice('darwin', {}), /libsecret/)
    assert.doesNotMatch(vaultAdvice('win32', {}), /libsecret/)
  })

  it('nomme sur chaque plateforme l’utilitaire qu’on peut aller vérifier', () => {
    assert.match(vaultAdvice('darwin', {}), /security/)
    assert.match(vaultAdvice('win32', {}), /powershell\.exe/)
    assert.match(vaultAdvice('linux', {}), /secret-tool/)
  })

  it('dit partout que les clés sont en clair : c’est ce qui justifie le reste', () => {
    for (const p of ['darwin', 'win32', 'linux', 'freebsd'] as const) {
      assert.match(vaultAdvice(p, {}), /en clair sur le disque/)
    }
  })
})
