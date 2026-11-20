import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_navigation_states (
    project_id TEXT NOT NULL, state_id TEXT NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY (project_id, state_id)
  )`;
  yield* sql`CREATE TABLE project_navigation_observations (
    observation_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    run_id TEXT NOT NULL, tab_id TEXT NOT NULL, state_id TEXT NOT NULL,
    step_index INTEGER NOT NULL, transition_json TEXT, observed_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX project_navigation_run_idx ON project_navigation_observations(project_id, run_id, tab_id)`;
  yield* sql`CREATE TABLE project_navigation_feedback (
    feedback_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, transition_id TEXT NOT NULL,
    run_id TEXT NOT NULL, outcome TEXT NOT NULL, observed_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX project_navigation_feedback_idx ON project_navigation_feedback(project_id, transition_id)`;
});
