import { NavigationRevision } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

const revisionJson = Schema.fromJsonString(NavigationRevision);
const decodeRevision = Schema.decodeEffect(revisionJson);
const encodeRevision = Schema.encodeEffect(revisionJson);

function mergeNavigationHints(a: NavigationRevision, b: NavigationRevision): NavigationRevision {
  const clusters = [
    ...new Map([...a.clusters, ...b.clusters].map((c) => [JSON.stringify(c), c])).values(),
  ];
  const stateIds = [...new Set([...a.stateIds, ...b.stateIds])];
  const all = a.all || b.all || clusters.length > 50 || stateIds.length > 50;
  return {
    revision: Math.max(a.revision, b.revision),
    clusters: all ? [] : clusters,
    stateIds: all ? [] : stateIds,
    all,
  };
}

// The pending hint is a bounded transactional outbox; publication only reads committed rows.
export const bumpNavigationRevision = Effect.fn("ProjectNavigationMemory.bumpRevision")(function* (
  sql: SqlClient.SqlClient,
  projectId: string,
  stateIds: readonly string[],
  all = false,
) {
  const rows =
    stateIds.length === 0
      ? []
      : yield* sql<{
          environment: string;
          pathGroup: string;
        }>`SELECT DISTINCT environment, path_group AS pathGroup FROM project_navigation_states WHERE project_id = ${projectId} AND state_id IN ${sql.in(stateIds.slice(0, 51))} LIMIT 51`;
  const [previous] = yield* sql<{
    revision: number;
    hint: string;
    pending: number;
  }>`SELECT revision, hint, pending FROM project_navigation_revisions WHERE project_id = ${projectId}`;
  const revision = (previous?.revision ?? 0) + 1;
  const hint = mergeNavigationHints(
    previous?.pending
      ? yield* decodeRevision(previous.hint)
      : { revision, clusters: [], stateIds: [], all: false },
    { revision, clusters: rows, stateIds, all },
  );
  yield* sql`INSERT INTO project_navigation_revisions (project_id, revision, hint, pending) VALUES (${projectId}, ${revision}, ${yield* encodeRevision(hint)}, 1) ON CONFLICT(project_id) DO UPDATE SET revision = excluded.revision, hint = excluded.hint, pending = 1`;
});
