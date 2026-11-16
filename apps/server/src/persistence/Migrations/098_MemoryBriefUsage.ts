import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE project_memory_brief_usage (
      thread_id TEXT PRIMARY KEY,
      characters INTEGER NOT NULL,
      estimated_tokens INTEGER NOT NULL
    )
  `;
});
