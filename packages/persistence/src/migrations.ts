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
 * Limites par défaut appliquées aux tâches de la Slice 1, qui n'en avaient pas.
 *
 * Écrites en toutes lettres dans le SQL de la migration 2 plutôt qu'importées de
 * `@midgaard/contracts` : une migration publiée ne se modifie plus, et elle doit
 * donc produire le même résultat dans dix versions, même si les valeurs par
 * défaut du code ont changé entre-temps. Importer une constante vivante ferait
 * dériver une migration figée.
 */
const SLICE1_DEFAULT_LIMITS =
  '{"max_steps":12,"max_cost_usd":0.5,"timeout_s":300,"max_output_tokens":4096,"max_tool_calls_per_step":5}'

/** Consommation nulle, pour les tâches antérieures au comptage des coûts. */
const ZERO_USAGE =
  '{"model_calls":0,"input_tokens":0,"output_tokens":0,"reasoning_tokens":0,"cached_tokens":0,' +
  '"web_searches":0,"cost_usd":0,"cost_source":"unknown","cost_usd_estimated":null,"cost_usd_reported":null}'

/**
 * Migrations, dans l'ordre. La version 1 est le schéma de la Slice 1, les
 * versions 2 et 3 celui de la Slice 2, la 4 ouvre la Slice 3.
 *
 * Des tables prévues au plan (§6), deux n'existeront pas. `projects` : un
 * projet est le dépôt d'où la tâche est déléguée, déjà porté par
 * `tasks.project_dir` et `workspaces.repo_dir` — une table de plus serait une
 * copie à tenir cohérente. `artifacts` : le diff d'un worktree se calcule à la
 * demande, et le figer en ferait une seconde vérité. `usage` n'a pas de table
 * non plus — voir la migration 2.
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
  {
    version: 2,
    label: 'Slice 2 — agents, fournisseurs, appels d\'outils, consommation',
    sql: `
      -- Les tâches gagnent de quoi dire QUI les exécute, avec QUEL contexte,
      -- sous QUELLES limites, et ce qu'elles ont COÛTÉ.
      --
      -- 'agent_id' prend 'simulated' par défaut : les tâches de la Slice 1 ont
      -- toutes été exécutées par le moteur simulé, et le dire après coup est
      -- exact, alors que les laisser sans agent obligerait tout le code aval à
      -- traiter un cas « tâche sans exécutant » qui n'existe pas.
      ALTER TABLE tasks ADD COLUMN agent_id    TEXT NOT NULL DEFAULT 'simulated';
      ALTER TABLE tasks ADD COLUMN context     TEXT;
      ALTER TABLE tasks ADD COLUMN limits_json TEXT NOT NULL DEFAULT '${SLICE1_DEFAULT_LIMITS}';
      ALTER TABLE tasks ADD COLUMN usage_json  TEXT NOT NULL DEFAULT '${ZERO_USAGE}';
      CREATE INDEX tasks_agent_idx ON tasks(agent_id);

      -- Fournisseurs de modèles. 'secret_ref' désigne une clé dans le coffre
      -- système : cette table n'en contient jamais aucune, pour qu'une base
      -- copiée ou sauvegardée ne donne accès à rien (§5 du plan).
      CREATE TABLE provider_configs (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        kind           TEXT NOT NULL,
        preset         TEXT NOT NULL,
        base_url       TEXT,
        default_model  TEXT NOT NULL,
        secret_ref     TEXT,
        web_search     TEXT NOT NULL DEFAULT 'off',
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        last_test_json TEXT
      );

      -- Profils d'agents. 'provider_id' est volontairement SANS clé étrangère :
      -- supprimer un fournisseur ne doit pas faire disparaître les profils qui
      -- s'y référaient, sinon l'utilisateur perd sa configuration en voulant
      -- changer de clé. Un profil orphelin se désactive, il ne s'efface pas.
      CREATE TABLE agents (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        kind          TEXT NOT NULL,
        description   TEXT NOT NULL DEFAULT '',
        provider_id   TEXT,
        model         TEXT,
        system_prompt TEXT NOT NULL DEFAULT '',
        tools_json    TEXT NOT NULL DEFAULT '[]',
        limits_json   TEXT NOT NULL,
        enabled       INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );

      -- Appels d'outils. Arguments et résultats y sont stockés EXPURGÉS : si une
      -- clé traverse un outil, elle ne doit pas se retrouver en clair dans une
      -- base que l'utilisateur sauvegardera sans y penser.
      CREATE TABLE tool_calls (
        id             TEXT PRIMARY KEY,
        task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        step           INTEGER NOT NULL,
        call_id        TEXT NOT NULL,
        name           TEXT NOT NULL,
        status         TEXT NOT NULL,
        decision       TEXT NOT NULL,
        arguments_json TEXT NOT NULL DEFAULT '{}',
        result_summary TEXT,
        result_bytes   INTEGER,
        duration_ms    INTEGER,
        error          TEXT,
        requested_at   TEXT NOT NULL,
        ended_at       TEXT
      );
      CREATE INDEX tool_calls_task_idx ON tool_calls(task_id, requested_at);
    `,
  },
  {
    version: 3,
    label: 'Slice 2 — racine de lecture d\'une tâche',
    sql: `
      -- Dossier que l'agent a le droit de lire, transmis par le serveur MCP à la
      -- délégation (son propre dossier de travail, donc le dépôt ouvert dans la
      -- session Claude Code).
      --
      -- NULL pour les tâches simulées, qui ne lisent rien. Une migration à part
      -- de la 2 parce que celle-ci était déjà appliquée aux bases de développement
      -- quand le besoin est apparu : une migration publiée ne se modifie plus,
      -- même la veille.
      ALTER TABLE tasks ADD COLUMN project_dir TEXT;
    `,
  },
  {
    version: 4,
    label: 'Slice 3 — worktrees des agents écrivants',
    sql: `
      -- Un worktree Git par tâche d'agent écrivant (PLAN §6). Sans cette table,
      -- les worktrees laissés par un crash seraient impossibles à retrouver de
      -- façon fiable : le dossier seul ne dit ni à quelle tâche il appartient,
      -- ni de quel commit il est parti.
      --
      -- base_commit est la référence de tout diff : jamais la branche d'origine,
      -- qui a pu avancer depuis. base_dirty compte les chemins non commités du
      -- dépôt d'origine au moment de la délégation — absents du worktree, et
      -- donc à annoncer. La ligne n'est jamais supprimée : 'removed' garde la
      -- trace de la branche, qui survit au worktree.
      CREATE TABLE workspaces (
        id            TEXT PRIMARY KEY,
        task_id       TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
        repo_dir      TEXT NOT NULL,
        subdir        TEXT NOT NULL DEFAULT '',
        worktree_path TEXT NOT NULL UNIQUE,
        branch        TEXT NOT NULL,
        base_commit   TEXT NOT NULL,
        base_ref      TEXT,
        base_dirty    INTEGER NOT NULL DEFAULT 0,
        status        TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        removed_at    TEXT
      );
      CREATE INDEX workspaces_status_idx ON workspaces(status, created_at);
    `,
  },
  {
    version: 5,
    label: 'Slice 3 — opération exacte des approbations',
    sql: `
      -- La forme structurée de ce qu'une approbation autorise : pour 'exec', le
      -- programme résolu, les arguments, le dossier absolu et l'empreinte du
      -- binaire. L'empreinte 'operation_hash' est tirée de ce JSON canonique, et
      -- non plus du texte affiché : deux opérations qui s'affichent pareil
      -- n'ont plus la même empreinte. NULL pour les demandes plus anciennes.
      ALTER TABLE approvals ADD COLUMN operation_json TEXT;
    `,
  },
  {
    version: 6,
    label: 'Slice 3 — liste blanche exec par projet',
    sql: `
      -- Commandes qu'exec lance sans approbation, pour UN dépôt (sa racine
      -- canonique). Le plan (§5) voulait une liste par projet ; la variable
      -- MIDGAARD_EXEC_ALLOW, globale, reste et s'y ajoute.
      --
      -- argv_json est l'argv EXACT, en JSON : 'npm test' n'autorise pas
      -- 'npm test -- --watch'. added_by dit qui l'a ajoutée — un humain, par la
      -- CLI ; une entrée sans auteur ne se relirait pas.
      CREATE TABLE exec_allow (
        repo_dir   TEXT NOT NULL,
        argv_json  TEXT NOT NULL,
        added_at   TEXT NOT NULL,
        added_by   TEXT NOT NULL,
        PRIMARY KEY (repo_dir, argv_json)
      );
    `,
  },
]

// Pas de table 'usage' : la consommation d'une tâche vit dans 'tasks.usage_json',
// et son historique est déjà dans le journal, où chaque 'usage.updated' porte le
// cumul du moment. Une table de plus n'ajouterait qu'une troisième copie à tenir
// cohérente avec les deux autres. Le plan (§6) la prévoyait ; c'est un écart
// assumé, documenté dans docs/SLICE2.md.

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
