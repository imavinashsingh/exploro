import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const decodeState = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.String,
      aliases: Schema.Array(Schema.String),
      environment: Schema.String,
      path: Schema.String,
      checks: Schema.Array(Schema.Unknown),
    }),
  ),
);

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
const pathGroup = (path: string) => `/${path.split(/[?#]/u)[0]!.split("/").find(Boolean) ?? ""}`;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE project_navigation_states ADD COLUMN environment TEXT NOT NULL DEFAULT ''`;
  yield* sql`ALTER TABLE project_navigation_states ADD COLUMN path TEXT NOT NULL DEFAULT ''`;
  yield* sql`ALTER TABLE project_navigation_states ADD COLUMN path_group TEXT NOT NULL DEFAULT '/'`;
  yield* sql`ALTER TABLE project_navigation_states ADD COLUMN check_count INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE project_navigation_states ADD COLUMN incoming_count INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE project_navigation_states ADD COLUMN outgoing_count INTEGER NOT NULL DEFAULT 0`;
  yield* sql`CREATE INDEX navigation_address_idx ON project_navigation_states(project_id, environment, path, check_count DESC, state_id)`;
  yield* sql`CREATE INDEX navigation_group_idx ON project_navigation_states(project_id, environment, path_group, state_id, incoming_count, outgoing_count)`;
  yield* sql`ALTER TABLE project_navigation_observations ADD COLUMN transition_id TEXT`;
  yield* sql`CREATE INDEX navigation_observation_transition_idx ON project_navigation_observations(project_id, transition_id)`;
  yield* sql`CREATE INDEX navigation_observation_state_idx ON project_navigation_observations(project_id, state_id, observed_at DESC, run_id, thread_id)`;
  yield* sql`CREATE INDEX navigation_observation_run_idx ON project_navigation_observations(run_id, project_id, transition_id)`;
  yield* sql`CREATE INDEX navigation_feedback_run_idx ON project_navigation_feedback(run_id, project_id, transition_id)`;
  yield* sql`CREATE INDEX navigation_feedback_mismatch_idx ON project_navigation_feedback(project_id, transition_id, outcome, observed_at DESC)`;
  yield* sql`CREATE INDEX navigation_observation_tab_idx ON project_navigation_observations(project_id, run_id, thread_id, tab_id)`;
  yield* sql`CREATE TABLE project_navigation_connections (
    project_id TEXT NOT NULL, transition_id TEXT NOT NULL, from_state_id TEXT NOT NULL, to_state_id TEXT NOT NULL,
    action TEXT NOT NULL, conditions_json TEXT NOT NULL, last_run_id TEXT NOT NULL, last_thread_id TEXT NOT NULL,
    last_observed_at TEXT NOT NULL, observation_count INTEGER NOT NULL, last_mismatch_at TEXT,
    available INTEGER GENERATED ALWAYS AS (last_mismatch_at IS NULL OR last_mismatch_at < last_observed_at) STORED,
    PRIMARY KEY(project_id, transition_id))`;
  yield* sql`CREATE INDEX navigation_outgoing_idx ON project_navigation_connections(project_id, from_state_id, transition_id)`;
  yield* sql`CREATE INDEX navigation_incoming_idx ON project_navigation_connections(project_id, to_state_id, transition_id)`;
  yield* sql`CREATE INDEX navigation_outgoing_available_idx ON project_navigation_connections(project_id, from_state_id, available, transition_id)`;
  yield* sql`CREATE INDEX navigation_incoming_available_idx ON project_navigation_connections(project_id, to_state_id, available, transition_id)`;
  yield* sql`CREATE INDEX navigation_recent_idx ON project_navigation_connections(project_id, last_observed_at DESC, transition_id)`;
  yield* sql`CREATE TABLE project_navigation_terms (
    project_id TEXT NOT NULL, environment TEXT NOT NULL, kind TEXT NOT NULL, term TEXT NOT NULL COLLATE BINARY, state_id TEXT NOT NULL,
    PRIMARY KEY(project_id, kind, term, environment, state_id)) WITHOUT ROWID`;
  yield* sql`CREATE INDEX navigation_destination_terms_idx ON project_navigation_terms(project_id, environment, kind, term, state_id)`;
  yield* sql`CREATE INDEX navigation_terms_state_idx ON project_navigation_terms(project_id, state_id)`;
  yield* sql`CREATE VIRTUAL TABLE project_navigation_search USING fts5(text, tokenize='trigram')`;
  yield* sql`DROP INDEX project_navigation_run_idx`;
  yield* sql`DROP INDEX project_navigation_feedback_idx`;
  let cursor = 0;
  while (true) {
    const rows = yield* sql<{
      rowid: number;
      project_id: string;
      state_id: string;
      data: string;
    }>`SELECT rowid, project_id, state_id, data FROM project_navigation_states WHERE rowid > ${cursor} ORDER BY rowid LIMIT 500`;
    if (rows.length === 0) break;
    for (const row of rows) {
      const state = yield* decodeState(row.data);
      const names = [state.name, ...state.aliases].map((name) => name.toLowerCase());
      yield* sql`UPDATE project_navigation_states SET environment = ${state.environment}, path = ${state.path}, path_group = ${pathGroup(state.path)}, check_count = ${state.checks.length} WHERE rowid = ${row.rowid}`;
      const terms = [...new Set([row.state_id.toLowerCase(), ...names])].map((term) => ({
        project_id: row.project_id,
        environment: state.environment,
        kind: "name",
        term,
        state_id: row.state_id,
      }));
      terms.push(
        ...words(names.join(" ")).map((term) => ({
          project_id: row.project_id,
          environment: state.environment,
          kind: "word",
          term,
          state_id: row.state_id,
        })),
      );
      const [first, ...rest] = terms;
      if (first !== undefined)
        yield* sql`INSERT INTO project_navigation_terms ${sql.insert([first, ...rest])}`;
      yield* sql`INSERT INTO project_navigation_search(rowid, text) VALUES (${row.rowid}, ${`${names.join(" ")} ${state.path.toLowerCase()}`})`;
    }
    cursor = rows.at(-1)!.rowid;
  }
  yield* sql`UPDATE project_navigation_observations SET transition_id = json_extract(transition_json, '$.id') WHERE transition_json IS NOT NULL`;
  yield* sql`INSERT INTO project_navigation_connections
    (project_id, transition_id, from_state_id, to_state_id, action, conditions_json, last_run_id, last_thread_id, last_observed_at, observation_count, last_mismatch_at)
    SELECT o.project_id, o.transition_id, json_extract(o.transition_json, '$.from'), json_extract(o.transition_json, '$.to'),
      json_extract(o.transition_json, '$.action'), json_extract(o.transition_json, '$.conditions'),
      json_extract(o.transition_json, '$.runId'), json_extract(o.transition_json, '$.threadId'), json_extract(o.transition_json, '$.observedAt'), grouped.count,
      (SELECT MAX(observed_at) FROM project_navigation_feedback f WHERE f.project_id = o.project_id AND f.transition_id = o.transition_id AND outcome = 'mismatch')
    FROM (SELECT project_id, transition_id, MAX(rowid) AS latest, COUNT(*) AS count FROM project_navigation_observations WHERE transition_id IS NOT NULL GROUP BY project_id, transition_id) grouped
    JOIN project_navigation_observations o ON o.rowid = grouped.latest`;
  yield* sql`UPDATE project_navigation_states AS s SET outgoing_count = c.count
    FROM (SELECT project_id, from_state_id, COUNT(*) AS count FROM project_navigation_connections GROUP BY project_id, from_state_id) c
    WHERE s.project_id = c.project_id AND s.state_id = c.from_state_id`;
  yield* sql`UPDATE project_navigation_states AS s SET incoming_count = c.count
    FROM (SELECT project_id, to_state_id, COUNT(*) AS count FROM project_navigation_connections GROUP BY project_id, to_state_id) c
    WHERE s.project_id = c.project_id AND s.state_id = c.to_state_id`;
});
