import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Pre-release facts had no screen identity; reset facts and understanding rather than guess their states.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM project_memory_links`;
  yield* sql`DELETE FROM project_memory_dependencies`;
  yield* sql`DELETE FROM project_memory_understanding_versions`;
  yield* sql`DELETE FROM project_memory_understanding_search`;
  yield* sql`DELETE FROM project_memory_understanding`;
  yield* sql`DELETE FROM project_memory_facts`;
  yield* sql`DELETE FROM project_memory_deleted`;
  yield* sql`DELETE FROM project_memory_extractions`;
  yield* sql`DELETE FROM project_memory_brief_usage`;
  yield* sql`ALTER TABLE project_memory_facts ADD COLUMN state_id TEXT NOT NULL`;
  yield* sql`DROP INDEX project_memory_facts_current_idx`;
  yield* sql`DROP INDEX project_memory_facts_identity_idx`;
  yield* sql`CREATE UNIQUE INDEX project_memory_facts_current_idx
    ON project_memory_facts(project_id, state_id, kind, fact_key) WHERE status = 'current'`;
  yield* sql`CREATE INDEX project_memory_facts_identity_idx
    ON project_memory_facts(project_id, state_id, kind, fact_key, observed_at)`;
});
