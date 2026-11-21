import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const namesJson = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeNames = Schema.decodeEffect(namesJson);
const encodeNames = Schema.encodeEffect(namesJson);

const fillerWords = new Set([
  "the",
  "for",
  "and",
  "that",
  "with",
  "from",
  "can",
  "into",
  "this",
  "page",
  "screen",
  "view",
]);
const words = (text: string) =>
  [...new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u))].filter(
    (word) => (word.length >= 3 || /\p{N}/u.test(word)) && !fillerWords.has(word),
  );

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE project_navigation_states ADD COLUMN environment TEXT NOT NULL DEFAULT ''`;
  yield* sql`ALTER TABLE project_navigation_states ADD COLUMN path TEXT NOT NULL DEFAULT ''`;
  yield* sql`ALTER TABLE project_navigation_states ADD COLUMN path_group TEXT NOT NULL DEFAULT '/'`;
  yield* sql`ALTER TABLE project_navigation_states ADD COLUMN check_count INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE project_navigation_states ADD COLUMN incoming_count INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE project_navigation_states ADD COLUMN outgoing_count INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE project_navigation_observations ADD COLUMN transition_id TEXT`;
  yield* sql`CREATE TABLE project_navigation_connections (
    project_id TEXT NOT NULL, transition_id TEXT NOT NULL, from_state_id TEXT NOT NULL, to_state_id TEXT NOT NULL,
    action TEXT NOT NULL, conditions_json TEXT NOT NULL, last_run_id TEXT NOT NULL, last_thread_id TEXT NOT NULL,
    last_observed_at TEXT NOT NULL, observation_count INTEGER NOT NULL, last_mismatch_at TEXT,
    available INTEGER GENERATED ALWAYS AS (last_mismatch_at IS NULL OR last_mismatch_at < last_observed_at) STORED,
    PRIMARY KEY(project_id, transition_id))`;
  yield* sql`CREATE TABLE project_navigation_terms (
    project_id TEXT NOT NULL, environment TEXT NOT NULL, kind TEXT NOT NULL, term TEXT NOT NULL COLLATE BINARY, state_id TEXT NOT NULL,
    PRIMARY KEY(project_id, kind, term, environment, state_id)) WITHOUT ROWID`;
  yield* sql`CREATE VIRTUAL TABLE project_navigation_search USING fts5(text, tokenize='trigram')`;
  yield* sql`CREATE TABLE project_navigation_clusters (
    project_id TEXT NOT NULL, environment TEXT NOT NULL, path_group TEXT NOT NULL,
    state_count INTEGER NOT NULL, incoming_count INTEGER NOT NULL, outgoing_count INTEGER NOT NULL,
    PRIMARY KEY(project_id, environment, path_group)) WITHOUT ROWID`;
  yield* sql`CREATE TABLE project_navigation_cluster_connections (
    project_id TEXT NOT NULL, from_environment TEXT NOT NULL, from_path_group TEXT NOT NULL,
    to_environment TEXT NOT NULL, to_path_group TEXT NOT NULL, connection_count INTEGER NOT NULL,
    PRIMARY KEY(project_id, from_environment, from_path_group, to_environment, to_path_group)) WITHOUT ROWID`;
  yield* sql`DROP INDEX project_navigation_run_idx`;
  yield* sql`DROP INDEX project_navigation_feedback_idx`;
  yield* sql`UPDATE project_navigation_states SET
    environment = json_extract(data, '$.environment'), path = json_extract(data, '$.path'),
    check_count = json_array_length(data, '$.checks')`;
  yield* sql`WITH paths AS (
    SELECT rowid, ltrim(substr(path, 1, min(
      CASE WHEN instr(path, '?') = 0 THEN length(path) + 1 ELSE instr(path, '?') END,
      CASE WHEN instr(path, '#') = 0 THEN length(path) + 1 ELSE instr(path, '#') END) - 1), '/') AS clean
    FROM project_navigation_states)
    UPDATE project_navigation_states SET path_group = '/' ||
      substr(p.clean, 1, CASE WHEN instr(p.clean, '/') = 0 THEN length(p.clean) ELSE instr(p.clean, '/') - 1 END)
    FROM paths p WHERE project_navigation_states.rowid = p.rowid`;
  yield* sql`CREATE TEMP TABLE navigation_backfill_text (state_rowid INTEGER PRIMARY KEY, names TEXT NOT NULL, path TEXT NOT NULL, state_id TEXT NOT NULL)`;
  let cursor = 0;
  while (true) {
    const rows = yield* sql<{
      rowid: number;
      project_id: string;
      state_id: string;
      environment: string;
      names: string;
      path: string;
    }>`SELECT s.rowid, s.project_id, s.state_id, s.environment, s.path,
      (SELECT json_group_array(value) FROM (SELECT json_extract(s.data, '$.name') AS value
        UNION ALL SELECT value FROM json_each(s.data, '$.aliases'))) AS names
      FROM project_navigation_states s WHERE s.rowid > ${cursor} ORDER BY s.rowid LIMIT 1000`;
    if (rows.length === 0) break;
    // SQLite lower() is ASCII-only; matching requires Unicode case folding and word splitting.
    const normalized = yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        const names = (yield* decodeNames(row.names)).map((name) => name.toLowerCase());
        return { row, names: yield* encodeNames(names), words: words(names.join(" ")) };
      }),
    );
    const [firstText, ...restText] = normalized.map(({ row, names }) => ({
      state_rowid: row.rowid,
      names,
      path: row.path.toLowerCase(),
      state_id: row.state_id.toLowerCase(),
    }));
    if (firstText !== undefined)
      yield* sql`INSERT INTO navigation_backfill_text ${sql.insert([firstText, ...restText])}`;
    const terms = normalized.flatMap(({ row, words }) =>
      words.map((term) => ({
        project_id: row.project_id,
        environment: row.environment,
        kind: "word",
        term,
        state_id: row.state_id,
      })),
    );
    for (let offset = 0; offset < terms.length; offset += 1000) {
      const [first, ...rest] = terms.slice(offset, offset + 1000);
      if (first !== undefined)
        yield* sql`INSERT INTO project_navigation_terms ${sql.insert([first, ...rest])}`;
    }
    cursor = rows.at(-1)!.rowid;
  }
  yield* sql`INSERT INTO project_navigation_terms
    SELECT s.project_id, s.environment, 'name', n.value, s.state_id
    FROM navigation_backfill_text b JOIN project_navigation_states s ON s.rowid = b.state_rowid, json_each(b.names) n
    UNION SELECT s.project_id, s.environment, 'name', b.state_id, s.state_id
    FROM navigation_backfill_text b JOIN project_navigation_states s ON s.rowid = b.state_rowid`;
  yield* sql`INSERT INTO project_navigation_search(rowid, text)
    SELECT b.state_rowid, (SELECT group_concat(value, ' ') FROM json_each(b.names)) || ' ' || b.path
    FROM navigation_backfill_text b`;
  yield* sql`DROP TABLE navigation_backfill_text`;
  yield* sql`UPDATE project_navigation_observations SET transition_id = json_extract(transition_json, '$.id') WHERE transition_json IS NOT NULL`;
  yield* sql`INSERT INTO project_navigation_connections
    (project_id, transition_id, from_state_id, to_state_id, action, conditions_json, last_run_id, last_thread_id, last_observed_at, observation_count, last_mismatch_at)
    SELECT o.project_id, o.transition_id, json_extract(o.transition_json, '$.from'), json_extract(o.transition_json, '$.to'),
      json_extract(o.transition_json, '$.action'), json_extract(o.transition_json, '$.conditions'),
      json_extract(o.transition_json, '$.runId'), json_extract(o.transition_json, '$.threadId'), json_extract(o.transition_json, '$.observedAt'), grouped.count,
      NULL
    FROM (SELECT project_id, transition_id, MAX(rowid) AS latest, COUNT(*) AS count FROM project_navigation_observations WHERE transition_id IS NOT NULL GROUP BY project_id, transition_id) grouped
    JOIN project_navigation_observations o ON o.rowid = grouped.latest`;
  yield* sql`UPDATE project_navigation_connections AS c SET last_mismatch_at = f.latest
    FROM (SELECT project_id, transition_id, MAX(observed_at) AS latest
      FROM project_navigation_feedback WHERE outcome = 'mismatch' GROUP BY project_id, transition_id) f
    WHERE c.project_id = f.project_id AND c.transition_id = f.transition_id`;
  yield* sql`UPDATE project_navigation_states AS s SET outgoing_count = c.count
    FROM (SELECT project_id, from_state_id, COUNT(*) AS count FROM project_navigation_connections GROUP BY project_id, from_state_id) c
    WHERE s.project_id = c.project_id AND s.state_id = c.from_state_id`;
  yield* sql`UPDATE project_navigation_states AS s SET incoming_count = c.count
    FROM (SELECT project_id, to_state_id, COUNT(*) AS count FROM project_navigation_connections GROUP BY project_id, to_state_id) c
    WHERE s.project_id = c.project_id AND s.state_id = c.to_state_id`;
  yield* sql`INSERT INTO project_navigation_clusters
    SELECT project_id, environment, path_group, COUNT(*), SUM(incoming_count), SUM(outgoing_count)
    FROM project_navigation_states GROUP BY project_id, environment, path_group`;
  yield* sql`INSERT INTO project_navigation_cluster_connections
    SELECT c.project_id, f.environment, f.path_group, t.environment, t.path_group, COUNT(*)
    FROM project_navigation_connections c
    JOIN project_navigation_states f ON f.project_id = c.project_id AND f.state_id = c.from_state_id
    JOIN project_navigation_states t ON t.project_id = c.project_id AND t.state_id = c.to_state_id
    GROUP BY c.project_id, f.environment, f.path_group, t.environment, t.path_group`;
  yield* sql`CREATE INDEX navigation_address_idx ON project_navigation_states(project_id, environment, path, check_count DESC, state_id)`;
  yield* sql`CREATE INDEX navigation_group_idx ON project_navigation_states(project_id, environment, path_group, state_id, incoming_count, outgoing_count)`;
  yield* sql`CREATE INDEX navigation_observation_transition_idx ON project_navigation_observations(project_id, transition_id)`;
  yield* sql`CREATE INDEX navigation_observation_state_idx ON project_navigation_observations(project_id, state_id, observed_at DESC, run_id, thread_id)`;
  yield* sql`CREATE INDEX navigation_observation_run_idx ON project_navigation_observations(run_id, project_id, transition_id)`;
  yield* sql`CREATE INDEX navigation_feedback_run_idx ON project_navigation_feedback(run_id, project_id, transition_id)`;
  yield* sql`CREATE INDEX navigation_feedback_mismatch_idx ON project_navigation_feedback(project_id, transition_id, outcome, observed_at DESC)`;
  yield* sql`CREATE INDEX navigation_observation_tab_idx ON project_navigation_observations(project_id, run_id, thread_id, tab_id)`;
  yield* sql`CREATE INDEX navigation_outgoing_idx ON project_navigation_connections(project_id, from_state_id, transition_id)`;
  yield* sql`CREATE INDEX navigation_incoming_idx ON project_navigation_connections(project_id, to_state_id, transition_id)`;
  yield* sql`CREATE INDEX navigation_outgoing_available_idx ON project_navigation_connections(project_id, from_state_id, available, transition_id)`;
  yield* sql`CREATE INDEX navigation_incoming_available_idx ON project_navigation_connections(project_id, to_state_id, available, transition_id)`;
  yield* sql`CREATE INDEX navigation_recent_idx ON project_navigation_connections(project_id, last_observed_at DESC, transition_id)`;
  yield* sql`CREATE INDEX navigation_destination_terms_idx ON project_navigation_terms(project_id, environment, kind, term, state_id)`;
  yield* sql`CREATE INDEX navigation_terms_state_idx ON project_navigation_terms(project_id, state_id)`;
});
