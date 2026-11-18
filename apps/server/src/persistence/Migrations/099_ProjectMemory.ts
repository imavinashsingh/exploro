import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE project_memory_facts (
      fact_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      environment TEXT NOT NULL,
      route TEXT NOT NULL,
      kind TEXT NOT NULL,
      fact_key TEXT NOT NULL,
      value TEXT NOT NULL,
      detail TEXT,
      page_url TEXT,
      evidence_json TEXT NOT NULL,
      app_version TEXT,
      author TEXT NOT NULL,
      status TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      superseded_by TEXT
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX project_memory_facts_current_idx
    ON project_memory_facts(project_id, environment, route, kind, fact_key)
    WHERE status = 'current'
  `;
  yield* sql`
    CREATE INDEX project_memory_facts_identity_idx
    ON project_memory_facts(project_id, environment, route, kind, fact_key, observed_at)
  `;

  yield* sql`
    CREATE TABLE project_memory_understanding (
      item_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      statement TEXT NOT NULL,
      status TEXT NOT NULL,
      author TEXT NOT NULL,
      embedding BLOB,
      embedding_model TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX project_memory_understanding_project_idx
    ON project_memory_understanding(project_id, kind)
  `;

  yield* sql`
    CREATE TABLE project_memory_links (
      item_id TEXT NOT NULL,
      fact_id TEXT NOT NULL,
      PRIMARY KEY (item_id, fact_id)
    )
  `;
  yield* sql`
    CREATE INDEX project_memory_links_fact_idx ON project_memory_links(fact_id)
  `;

  yield* sql`
    CREATE TABLE project_memory_deleted (
      project_id TEXT NOT NULL,
      item_type TEXT NOT NULL,
      item_ref TEXT NOT NULL,
      deleted_at TEXT NOT NULL,
      PRIMARY KEY (project_id, item_type, item_ref)
    )
  `;
});
