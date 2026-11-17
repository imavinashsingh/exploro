import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE project_memory_understanding ADD COLUMN version INTEGER NOT NULL DEFAULT 1
  `;
  yield* sql`
    CREATE TABLE project_memory_understanding_versions (
      item_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      kind TEXT NOT NULL,
      statement TEXT NOT NULL,
      status TEXT NOT NULL,
      author TEXT NOT NULL,
      cited_fact_ids_json TEXT NOT NULL,
      depends_on_json TEXT NOT NULL,
      changed_at TEXT NOT NULL,
      PRIMARY KEY (item_id, version)
    )
  `;
  yield* sql`
    CREATE TABLE project_memory_dependencies (
      item_id TEXT NOT NULL,
      depends_on_item_id TEXT NOT NULL,
      PRIMARY KEY (item_id, depends_on_item_id)
    )
  `;
  yield* sql`
    CREATE INDEX project_memory_dependencies_target_idx
    ON project_memory_dependencies(depends_on_item_id)
  `;
  // ProjectUnderstanding writes a row with each item version; project_id keeps matches per project.
  yield* sql`
    CREATE VIRTUAL TABLE project_memory_understanding_search USING fts5(
      statement,
      item_id UNINDEXED,
      project_id UNINDEXED,
      tokenize = 'porter unicode61 remove_diacritics 2'
    )
  `;
  yield* sql`
    CREATE TABLE project_memory_extractions (
      run_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX project_memory_extractions_status_idx ON project_memory_extractions(status)
  `;
});
