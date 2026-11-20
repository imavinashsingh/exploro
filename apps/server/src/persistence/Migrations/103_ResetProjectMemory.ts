import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Pre-release memory mixed navigation recipes with QA knowledge; new runs learn them separately.
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
  yield* sql`DELETE FROM project_navigation_feedback`;
  yield* sql`DELETE FROM project_navigation_observations`;
  yield* sql`DELETE FROM project_navigation_states`;
});
