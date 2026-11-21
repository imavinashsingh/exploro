import { NavigationState, NavigationTransition } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { navigationDestinationWords } from "./navigation.ts";

export const navigationPathGroup = (path: string) =>
  `/${path.split(/[?#]/u)[0]!.split("/").find(Boolean) ?? ""}`;

const encodeContext = Schema.encodeEffect(Schema.fromJsonString(NavigationState.fields.context));
const decodeTransition = Schema.decodeEffect(Schema.fromJsonString(NavigationTransition));

export const indexNavigationState = Effect.fn("ProjectNavigationMemory.indexState")(function* (
  sql: SqlClient.SqlClient,
  projectId: string,
  state: NavigationState,
  isNew: boolean,
) {
  if (isNew)
    yield* sql`INSERT INTO project_navigation_clusters VALUES
    (${projectId}, ${state.environment}, ${navigationPathGroup(state.path)}, 1, 0, 0)
    ON CONFLICT(project_id, environment, path_group) DO UPDATE SET state_count = state_count + 1`;
  const names = [state.name, ...state.aliases].map((name) => name.toLowerCase());
  const text = `${names.join(" ")} ${state.path.toLowerCase()}`;
  yield* sql`UPDATE project_navigation_states SET environment = ${state.environment}, path = ${state.path},
    path_group = ${navigationPathGroup(state.path)}, check_count = ${state.checks.length}
    WHERE project_id = ${projectId} AND state_id = ${state.id}`;
  yield* sql`DELETE FROM project_navigation_terms WHERE project_id = ${projectId} AND state_id = ${state.id}`;
  const records = [...new Set([state.id.toLowerCase(), ...names])].map((term) => ({
    project_id: projectId,
    environment: state.environment,
    kind: "name",
    term,
    state_id: state.id,
  }));
  records.push(
    ...navigationDestinationWords(names.join(" ")).map((term) => ({
      project_id: projectId,
      environment: state.environment,
      kind: "word",
      term,
      state_id: state.id,
    })),
  );
  const [first, ...rest] = records;
  if (first !== undefined)
    yield* sql`INSERT INTO project_navigation_terms ${sql.insert([first, ...rest])}`;
  yield* sql`DELETE FROM project_navigation_search WHERE rowid = (SELECT rowid FROM project_navigation_states WHERE project_id = ${projectId} AND state_id = ${state.id})`;
  yield* sql`INSERT INTO project_navigation_search (rowid, text)
    SELECT rowid, ${text}
    FROM project_navigation_states WHERE project_id = ${projectId} AND state_id = ${state.id}`;
});

const adjustClusterConnection = Effect.fn("ProjectNavigationMemory.adjustClusterConnection")(
  function* (sql: SqlClient.SqlClient, projectId: string, from: string, to: string, delta: number) {
    yield* sql`UPDATE project_navigation_clusters SET outgoing_count = outgoing_count + ${delta}
    WHERE project_id = ${projectId} AND (environment, path_group) =
      (SELECT environment, path_group FROM project_navigation_states WHERE project_id = ${projectId} AND state_id = ${from})`;
    yield* sql`UPDATE project_navigation_clusters SET incoming_count = incoming_count + ${delta}
    WHERE project_id = ${projectId} AND (environment, path_group) =
      (SELECT environment, path_group FROM project_navigation_states WHERE project_id = ${projectId} AND state_id = ${to})`;
    yield* sql`INSERT INTO project_navigation_cluster_connections
    SELECT ${projectId}, f.environment, f.path_group, t.environment, t.path_group, ${delta}
    FROM project_navigation_states f JOIN project_navigation_states t ON t.project_id = f.project_id
    WHERE f.project_id = ${projectId} AND f.state_id = ${from} AND t.state_id = ${to}
    ON CONFLICT(project_id, from_environment, from_path_group, to_environment, to_path_group)
    DO UPDATE SET connection_count = connection_count + excluded.connection_count`;
    if (delta < 0)
      yield* sql`DELETE FROM project_navigation_cluster_connections WHERE project_id = ${projectId} AND connection_count = 0`;
  },
);

export const storeNavigationConnection = Effect.fn("ProjectNavigationMemory.storeConnection")(
  function* (sql: SqlClient.SqlClient, projectId: string, edge: NavigationTransition) {
    const [existing] =
      yield* sql`SELECT 1 FROM project_navigation_connections WHERE project_id = ${projectId} AND transition_id = ${edge.id}`;
    yield* sql`INSERT INTO project_navigation_connections
    (project_id, transition_id, from_state_id, to_state_id, action, conditions_json, last_run_id, last_thread_id, last_observed_at, observation_count, last_mismatch_at)
    VALUES (${projectId}, ${edge.id}, ${edge.from}, ${edge.to}, ${edge.action}, ${yield* encodeContext(edge.conditions)},
      ${edge.runId}, ${edge.threadId}, ${edge.observedAt}, 1,
      (SELECT MAX(observed_at) FROM project_navigation_feedback WHERE project_id = ${projectId} AND transition_id = ${edge.id} AND outcome = 'mismatch'))
    ON CONFLICT (project_id, transition_id) DO UPDATE SET
      last_run_id = excluded.last_run_id, last_thread_id = excluded.last_thread_id,
      last_observed_at = excluded.last_observed_at, observation_count = observation_count + 1`;
    if (existing === undefined) {
      yield* adjustClusterConnection(sql, projectId, edge.from, edge.to, 1);
      yield* sql`UPDATE project_navigation_states SET outgoing_count = outgoing_count + 1 WHERE project_id = ${projectId} AND state_id = ${edge.from}`;
      yield* sql`UPDATE project_navigation_states SET incoming_count = incoming_count + 1 WHERE project_id = ${projectId} AND state_id = ${edge.to}`;
    }
  },
);

export const rebuildNavigationConnection = Effect.fn("ProjectNavigationMemory.rebuildConnection")(
  function* (sql: SqlClient.SqlClient, projectId: string, transitionId: string) {
    const [old] = yield* sql<{
      from_state_id: string;
      to_state_id: string;
    }>`DELETE FROM project_navigation_connections WHERE project_id = ${projectId} AND transition_id = ${transitionId} RETURNING from_state_id, to_state_id`;
    if (old !== undefined) {
      yield* adjustClusterConnection(sql, projectId, old.from_state_id, old.to_state_id, -1);
      yield* sql`UPDATE project_navigation_states SET outgoing_count = outgoing_count - 1 WHERE project_id = ${projectId} AND state_id = ${old.from_state_id}`;
      yield* sql`UPDATE project_navigation_states SET incoming_count = incoming_count - 1 WHERE project_id = ${projectId} AND state_id = ${old.to_state_id}`;
    }
    const [row] = yield* sql<{ data: string; count: number }>`SELECT transition_json AS data,
    (SELECT COUNT(*) FROM project_navigation_observations WHERE project_id = ${projectId} AND transition_id = ${transitionId}) AS count
    FROM project_navigation_observations WHERE project_id = ${projectId} AND transition_id = ${transitionId} ORDER BY rowid DESC LIMIT 1`;
    if (row === undefined) return;
    yield* storeNavigationConnection(sql, projectId, yield* decodeTransition(row.data));
    yield* sql`UPDATE project_navigation_connections SET observation_count = ${row.count}
    WHERE project_id = ${projectId} AND transition_id = ${transitionId}`;
  },
);

export const deleteNavigationState = Effect.fn("ProjectNavigationMemory.deleteState")(function* (
  sql: SqlClient.SqlClient,
  projectId: string,
  stateId: string,
) {
  yield* sql`UPDATE project_navigation_clusters SET state_count = state_count - 1
    WHERE project_id = ${projectId} AND (environment, path_group) =
      (SELECT environment, path_group FROM project_navigation_states WHERE project_id = ${projectId} AND state_id = ${stateId})`;
  yield* sql`DELETE FROM project_navigation_clusters WHERE project_id = ${projectId} AND state_count = 0`;
  yield* sql`DELETE FROM project_navigation_terms WHERE project_id = ${projectId} AND state_id = ${stateId}`;
  yield* sql`DELETE FROM project_navigation_search WHERE rowid = (SELECT rowid FROM project_navigation_states WHERE project_id = ${projectId} AND state_id = ${stateId})`;
  yield* sql`DELETE FROM project_navigation_states WHERE project_id = ${projectId} AND state_id = ${stateId}`;
});
