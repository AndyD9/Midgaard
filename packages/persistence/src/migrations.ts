/**
 * @file Schéma de la base et migrations versionnées.
 *
 * La version du schéma est suivie par `PRAGMA user_version`, un entier stocké
 * dans l'en-tête du fichier SQLite. Pas de table de suivi à maintenir, et la
 * lecture comme l'écriture participent à la transaction de la migration : une
 * migration interrompue ne laisse jamais une base à moitié migrée.
 *
 * **Règle** : une migration publiée ne se modifie plus. Toute évolution ajoute
 * une entrée à la fin de {@link MIGRATIONS}. Les bases des utilisateurs existent
 * déjà ; réécrire une migration passée les laisserait dans un état que personne
 * ne peut reproduire.
 */
import type { DatabaseSync } from 'node:sqlite'

/** Une étape de migration : du schéma `version - 1` vers `version`. */
export interface Migration {
  version: number
  /** Ce que cette étape apporte, pour le journal et la revue de code. */
  label: string
  sql: string
}

/**
 * Migrations, dans l'ordre. La version 1 est le schéma de la Slice 1.
 *
 * Les tables `projects`, `agents`, `tool_calls`, `artifacts`, `usage`,
 * `provider_configs` et `workspaces` prévues au plan (§6) arriveront avec les
 * fonctionnalités qui les remplissent (Slices 2 et 3) : créer des tables vides
 * d'avance fige un schéma qu'on n'a pas encore éprouvé.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    label: 'Slice 1 — tâches, journal d\'événements, approbations',
    sql: `
      CREATE TABLE tasks (
        id            TEXT    PRIMARY KEY,
        objective     TEXT    NOT NULL,
        status        TEXT    NOT NULL,
        step          INTEGER NOT NULL DEFAULT 0,
        steps_total   INTEGER NOT NULL,
        needs_approval INTEGER NOT NULL DEFAULT 0,
        approval_seq  INTEGER NOT NULL DEFAULT 0,
        duration_s    INTEGER NOT NULL,
        created_at    TEXT    NOT NULL,
        updated_at    TEXT    NOT NULL,
        started_at    TEXT,
        ended_at      TEXT,
        result_json   TEXT,
        error         TEXT
      );
      CREATE INDEX tasks_status_idx  ON tasks(status);
      CREATE INDEX tasks_created_idx ON tasks(created_at DESC);

      -- 'seq' est AUTOINCREMENT et non un simple rowid : SQLite réutilise les
      -- rowid libérés, ce qui casserait la reprise WebSocket (un client ayant vu
      -- la séquence 412 pourrait manquer un événement renuméroté 412).
      CREATE TABLE task_events (
        seq          INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id      TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        task_seq     INTEGER NOT NULL,
        type         TEXT    NOT NULL,
        status       TEXT    NOT NULL,
        at           TEXT    NOT NULL,
        payload_json TEXT    NOT NULL DEFAULT '{}',
        UNIQUE(task_id, task_seq)
      );
      CREATE INDEX task_events_task_idx ON task_events(task_id, task_seq);

      CREATE TABLE approvals (
        id             TEXT PRIMARY KEY,
        task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        seq            INTEGER NOT NULL,
        operation      TEXT NOT NULL,
        operation_hash TEXT NOT NULL,
        status         TEXT NOT NULL,
        requested_at   TEXT NOT NULL,
        expires_at     TEXT NOT NULL,
        resolved_at    TEXT,
        resolved_by    TEXT,
        reason         TEXT,
        UNIQUE(task_id, seq)
      );
      CREATE INDEX approvals_status_idx ON approvals(status);
    `,
  },
]

/** Version de schéma attendue par ce code. */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version

/**
 * Applique les migrations manquantes, chacune dans sa propre transaction.
 *
 * @param db     base ouverte
 * @param log    journalisation facultative, pour tracer les migrations appliquées
 * @returns la liste des versions appliquées pendant cet appel (vide si à jour)
 * @throws si la base est **plus récente** que ce code : une version future a pu
 *         changer le sens de colonnes existantes, et l'ouvrir quand même
 *         risquerait de corrompre des données qu'on ne comprend pas
 */
export function migrate(db: DatabaseSync, log: (msg: string) => void = () => {}): number[] {
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `base en version de schéma ${current}, ce code en connaît ${SCHEMA_VERSION} : ` +
        'mets à jour Midgaard, ou ouvre une autre base avec MIDGAARD_HOME.',
    )
  }
  const applied: number[] = []
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(m.sql)
      // `user_version` n'accepte pas de paramètre lié : la valeur vient de notre
      // propre table de migrations, jamais d'une entrée utilisateur.
      db.exec(`PRAGMA user_version = ${m.version}`)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    log(`migration ${m.version} appliquée : ${m.label}`)
    applied.push(m.version)
  }
  return applied
}
