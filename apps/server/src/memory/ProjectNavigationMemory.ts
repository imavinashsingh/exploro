import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import * as DateTime from "effect/DateTime";
import {
  NavigationSnapshot,
  NavigationState,
  NavigationTransition,
  ProjectMemoryError,
  type ProjectId,
  type NavigationRouteResult,
  NavigationOverviewInput,
  NavigationOverview,
  NavigationChildrenInput,
  NavigationStatePage,
  NavigationNeighborhoodInput,
  NavigationNeighborhood,
  NavigationSearchInput,
  NavigationDetailsInput,
  NavigationDetails,
  NavigationRoutePreviewInput,
  NavigationRoutePreview,
  type NavigationSummary,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";
import {
  findNavigationPath,
  isExactNavigationDestination,
  navigationDestinations,
  navigationDestinationWords,
  navigationStateKey,
  navigationTransitionKey,
} from "./navigation.ts";
import {
  indexNavigationState,
  deleteNavigationState,
  storeNavigationConnection,
  rebuildNavigationConnection,
} from "./navigationStorage.ts";

interface ObservationInput {
  readonly state: Omit<NavigationState, "id">;
  readonly threadId: string;
  readonly runId: string;
  readonly tabId: string;
  readonly stepIndex: number;
  readonly action?: string | undefined;
}

export class ProjectNavigationMemory extends Context.Service<
  ProjectNavigationMemory,
  {
    readonly statesAtAddress: (
      projectId: ProjectId,
      environment: string,
      path: string,
      context?: Readonly<Record<string, string>>,
    ) => Effect.Effect<ReadonlyArray<NavigationState>, ProjectMemoryError>;
    readonly destinations: (
      projectId: ProjectId,
      environment: string,
      query: string,
    ) => Effect.Effect<
      { states: ReadonlyArray<NavigationState>; truncated: boolean },
      ProjectMemoryError
    >;
    readonly navigationRoute: (
      projectId: ProjectId,
      from: string,
      destination: string,
    ) => Effect.Effect<NavigationRouteResult, ProjectMemoryError>;
    readonly navigationOverview: (
      input: typeof NavigationOverviewInput.Type,
    ) => Effect.Effect<typeof NavigationOverview.Type, ProjectMemoryError>;
    readonly navigationChildren: (
      input: typeof NavigationChildrenInput.Type,
    ) => Effect.Effect<typeof NavigationStatePage.Type, ProjectMemoryError>;
    readonly navigationNeighborhood: (
      input: typeof NavigationNeighborhoodInput.Type,
    ) => Effect.Effect<typeof NavigationNeighborhood.Type, ProjectMemoryError>;
    readonly navigationSearch: (
      input: typeof NavigationSearchInput.Type,
    ) => Effect.Effect<typeof NavigationStatePage.Type, ProjectMemoryError>;
    readonly navigationDetails: (
      input: typeof NavigationDetailsInput.Type,
    ) => Effect.Effect<typeof NavigationDetails.Type, ProjectMemoryError>;
    readonly navigationRoutePreview: (
      input: typeof NavigationRoutePreviewInput.Type,
    ) => Effect.Effect<typeof NavigationRoutePreview.Type, ProjectMemoryError>;
    readonly observe: (
      projectId: ProjectId,
      input: ObservationInput,
    ) => Effect.Effect<NavigationState, ProjectMemoryError>;
    readonly snapshot: (
      projectId: ProjectId,
    ) => Effect.Effect<NavigationSnapshot, ProjectMemoryError>;
    readonly feedback: (
      projectId: ProjectId,
      runId: string,
      transitionId: string,
      outcome: "mismatch" | "tool-error",
    ) => Effect.Effect<void, ProjectMemoryError>;
    readonly deleteRecord: (
      projectId: ProjectId,
      id: string,
    ) => Effect.Effect<void, ProjectMemoryError>;
  }
>()("t3/memory/ProjectNavigationMemory") {}

const isMemoryError = Schema.is(ProjectMemoryError);
const failure = (cause: unknown) =>
  isMemoryError(cause)
    ? cause
    : new ProjectMemoryError({ message: "Could not access navigation memory.", cause });
const encodeState = Schema.encodeEffect(Schema.fromJsonString(NavigationState));
const encodeTransition = Schema.encodeEffect(Schema.fromJsonString(NavigationTransition));
const stateJson = Schema.decodeEffect(Schema.fromJsonString(NavigationState));
const decodeCursor = Schema.decodeEffect(Schema.fromJsonString(Schema.String));
const encodeContext = Schema.encodeEffect(Schema.fromJsonString(NavigationState.fields.context));

export function navigationRoute(
  snapshot: NavigationSnapshot,
  from: string,
  destination: string,
): NavigationRouteResult {
  const start = snapshot.states.find((state) => state.id === from);
  const candidates = navigationDestinations(snapshot.states, destination).filter(
    (state) =>
      start !== undefined &&
      Object.entries(state.context).every(
        ([key, value]) => key === "authenticated" || start.context[key] === value,
      ),
  );
  if (start === undefined) return { status: "unrecognized" as const, candidates: [], steps: [] };
  if (candidates.length !== 1)
    return {
      status: candidates.length > 1 ? ("ambiguous" as const) : ("no-route" as const),
      candidates: candidates.slice(0, 8),
      steps: [],
    };
  const target = candidates[0]!;
  if (from === target.id && !isExactNavigationDestination(target, destination))
    return { status: "no-route", candidates: [target], steps: [] };
  const path =
    from === target.id
      ? []
      : findNavigationPath(snapshot.states, snapshot.transitions, from, target.id, start.context);
  return {
    status:
      path === null
        ? ("no-route" as const)
        : path.length === 0
          ? ("already-there" as const)
          : ("found" as const),
    candidates: [target],
    // The address the screen was seen at; opening it skips clicks, but only a live check confirms it.
    ...(from === target.id ? {} : { directUrl: `${target.environment}${target.path}` }),
    steps: (path ?? []).flatMap((transition) => {
      const state = snapshot.states.find((s) => s.id === transition.to);
      return state === undefined ? [] : [{ transition, destination: state }];
    }),
  };
}

const preparePrune = Effect.fn("ProjectNavigationMemory.preparePrune")(function* (
  sql: SqlClient.SqlClient,
) {
  yield* sql`CREATE TEMP TABLE IF NOT EXISTS navigation_prune (project_id TEXT NOT NULL, state_id TEXT NOT NULL, PRIMARY KEY(project_id, state_id)) WITHOUT ROWID`;
  yield* sql`DELETE FROM navigation_prune`;
});
const pruneStates = Effect.fn("ProjectNavigationMemory.pruneStates")(function* (
  sql: SqlClient.SqlClient,
) {
  yield* sql`DELETE FROM navigation_prune WHERE (project_id, state_id) NOT IN (SELECT project_id, state_id FROM project_navigation_states WHERE (project_id, state_id) IN (SELECT project_id, state_id FROM navigation_prune)
    AND NOT EXISTS (SELECT 1 FROM project_navigation_observations o WHERE o.project_id = project_navigation_states.project_id AND o.state_id = project_navigation_states.state_id)
    AND NOT EXISTS (SELECT 1 FROM project_memory_facts f WHERE f.project_id = project_navigation_states.project_id AND f.state_id = project_navigation_states.state_id)
    AND NOT EXISTS (SELECT 1 FROM project_navigation_connections c WHERE c.project_id = project_navigation_states.project_id AND c.from_state_id = project_navigation_states.state_id)
    AND NOT EXISTS (SELECT 1 FROM project_navigation_connections c WHERE c.project_id = project_navigation_states.project_id AND c.to_state_id = project_navigation_states.state_id))`;
  while (true) {
    const rows = yield* sql<{
      project_id: string;
      state_id: string;
    }>`SELECT project_id, state_id FROM navigation_prune LIMIT 500`;
    if (rows.length === 0) break;
    for (const row of rows) {
      yield* deleteNavigationState(sql, row.project_id, row.state_id);
      yield* sql`DELETE FROM navigation_prune WHERE project_id = ${row.project_id} AND state_id = ${row.state_id}`;
    }
  }
});

/** Runs inside the caller's transaction; states another run still observed stay. */
export const forgetNavigationRun = Effect.fn("ProjectNavigationMemory.forgetRun")(function* (
  sql: SqlClient.SqlClient,
  runId: string,
) {
  yield* preparePrune(sql);
  yield* sql`CREATE TEMP TABLE IF NOT EXISTS navigation_rebuild (project_id TEXT NOT NULL, transition_id TEXT NOT NULL, PRIMARY KEY(project_id, transition_id)) WITHOUT ROWID`;
  yield* sql`DELETE FROM navigation_rebuild`;
  yield* sql`INSERT OR IGNORE INTO navigation_rebuild
    SELECT project_id, transition_id FROM project_navigation_observations WHERE run_id = ${runId} AND transition_id IS NOT NULL
    UNION SELECT project_id, transition_id FROM project_navigation_feedback WHERE run_id = ${runId}`;
  yield* sql`INSERT OR IGNORE INTO navigation_prune SELECT project_id, state_id FROM project_navigation_observations WHERE run_id = ${runId}`;
  yield* sql`INSERT OR IGNORE INTO navigation_prune SELECT c.project_id, c.from_state_id FROM navigation_rebuild r
    JOIN project_navigation_connections c ON c.project_id = r.project_id AND c.transition_id = r.transition_id
    UNION SELECT c.project_id, c.to_state_id FROM navigation_rebuild r
    JOIN project_navigation_connections c ON c.project_id = r.project_id AND c.transition_id = r.transition_id`;
  while (true) {
    const rows = yield* sql<{
      observation_id: string;
    }>`SELECT observation_id FROM project_navigation_observations WHERE run_id = ${runId} LIMIT 500`;
    if (rows.length === 0) break;
    yield* sql`DELETE FROM project_navigation_observations WHERE observation_id IN ${sql.in(rows.map((r) => r.observation_id))}`;
  }
  while (true) {
    const rows = yield* sql<{
      feedback_id: string;
    }>`SELECT feedback_id FROM project_navigation_feedback WHERE run_id = ${runId} LIMIT 500`;
    if (rows.length === 0) break;
    yield* sql`DELETE FROM project_navigation_feedback WHERE feedback_id IN ${sql.in(rows.map((r) => r.feedback_id))}`;
  }
  while (true) {
    const rows = yield* sql<{
      project_id: string;
      transition_id: string;
    }>`SELECT project_id, transition_id FROM navigation_rebuild LIMIT 500`;
    if (rows.length === 0) break;
    for (const row of rows) {
      yield* rebuildNavigationConnection(sql, row.project_id, row.transition_id);
      yield* sql`DELETE FROM navigation_rebuild WHERE project_id = ${row.project_id} AND transition_id = ${row.transition_id}`;
    }
  }
  yield* pruneStates(sql);
});

interface ConnectionRow {
  transition_id: string;
  from_state_id: string;
  to_state_id: string;
  action: string;
  conditions_json: string;
  last_run_id: string;
  last_thread_id: string;
  last_observed_at: string;
  last_mismatch_at: string | null;
  observation_count: number;
}
const connection = (row: ConnectionRow): NavigationTransition => ({
  id: row.transition_id,
  from: row.from_state_id,
  to: row.to_state_id,
  action: row.action,
  conditions: JSON.parse(row.conditions_json) as Readonly<Record<string, string>>,
  runId: row.last_run_id,
  threadId: row.last_thread_id,
  observedAt: row.last_observed_at,
  available: row.last_mismatch_at === null || row.last_mismatch_at < row.last_observed_at,
});
const ROUTE_BUDGET = 2000;
const cursorValue = Effect.fn("ProjectNavigationMemory.cursor")(function* (cursor?: string) {
  if (cursor === undefined) return "";
  return yield* decodeCursor(Buffer.from(cursor, "base64url").toString());
});
const pageCursor = (id: string) => Buffer.from(JSON.stringify(id)).toString("base64url");

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const digest = yield* Digest.Digest;
  const hash = Effect.fn("ProjectNavigationMemory.hash")(function* (text: string) {
    return Hex.encode(yield* digest.digest(Digest.sha256, new TextEncoder().encode(text)));
  });
  const random = yield* SecureRandom.SecureRandom;
  const now = Clock.currentTimeMillis.pipe(
    Effect.map((value) => DateTime.formatIso(DateTime.makeUnsafe(value))),
  );
  const snapshot = Effect.fn("ProjectNavigationMemory.snapshot")(function* (projectId: ProjectId) {
    const states = yield* sql<{
      data: string;
    }>`SELECT data FROM project_navigation_states WHERE project_id = ${projectId} AND (EXISTS (
      SELECT 1 FROM project_navigation_observations o WHERE o.project_id = ${projectId} AND o.state_id = project_navigation_states.state_id
    ) OR EXISTS (
      SELECT 1 FROM project_memory_facts f WHERE f.project_id = ${projectId} AND f.state_id = project_navigation_states.state_id
    ) OR EXISTS (SELECT 1 FROM project_navigation_connections c WHERE c.project_id = ${projectId} AND c.from_state_id = project_navigation_states.state_id)
      OR EXISTS (SELECT 1 FROM project_navigation_connections c WHERE c.project_id = ${projectId} AND c.to_state_id = project_navigation_states.state_id)) ORDER BY state_id LIMIT 501`;
    const rows =
      yield* sql<ConnectionRow>`SELECT * FROM project_navigation_connections WHERE project_id = ${projectId}
      ORDER BY last_observed_at DESC, transition_id LIMIT 1001`;
    const transitions = rows.slice(0, 1000).map(connection);
    const decodedStates = yield* Effect.forEach(states.slice(0, 500), (row) => stateJson(row.data));
    const knownStates = new Set(decodedStates.map((state) => state.id));
    const knownEdges = transitions.filter(
      (edge) => knownStates.has(edge.from) && knownStates.has(edge.to),
    );
    return NavigationSnapshot.make({
      states: decodedStates,
      transitions: knownEdges,
      truncated: states.length > 500 || rows.length > 1000,
    });
  }, Effect.mapError(failure));

  const getState = Effect.fn("ProjectNavigationMemory.getState")(function* (
    projectId: ProjectId,
    id: string,
  ) {
    const [row] = yield* sql<{
      data: string;
    }>`SELECT data FROM project_navigation_states WHERE project_id = ${projectId} AND state_id = ${id}`;
    return row === undefined ? null : yield* stateJson(row.data);
  });
  const summary = Effect.fn("ProjectNavigationMemory.summary")(function* (
    projectId: ProjectId,
    id: string,
  ) {
    const state = yield* getState(projectId, id);
    if (state === null) return null;
    const [counts] = yield* sql<{
      incomingCount: number;
      outgoingCount: number;
    }>`SELECT incoming_count AS incomingCount,
      outgoing_count AS outgoingCount FROM project_navigation_states WHERE project_id = ${projectId} AND state_id = ${id}`;
    return {
      id,
      name: state.name,
      environment: state.environment,
      path: state.path,
      ...counts!,
    } satisfies NavigationSummary;
  });
  const statesAtAddress = Effect.fn("ProjectNavigationMemory.statesAtAddress")(function* (
    projectId: ProjectId,
    environment: string,
    path: string,
    context: Readonly<Record<string, string>> = {},
  ) {
    const rows = yield* sql<{ data: string }>`SELECT data FROM project_navigation_states
      WHERE project_id = ${projectId} AND environment = ${environment} AND path = ${path}
      AND NOT EXISTS (SELECT 1 FROM json_each(${yield* encodeContext(context)}) c
        WHERE EXISTS (SELECT 1 FROM json_each(data, '$.context') saved WHERE saved.key = c.key AND saved.value != c.value))
      ORDER BY check_count DESC, state_id LIMIT 8`;
    return yield* Effect.forEach(rows, (row) => stateJson(row.data));
  }, Effect.mapError(failure));
  const destinations = Effect.fn("ProjectNavigationMemory.destinations")(function* (
    projectId: ProjectId,
    environment: string,
    query: string,
  ) {
    const normalized = query.trim().toLowerCase();
    const exact = yield* sql<{
      data: string;
    }>`SELECT s.data FROM project_navigation_terms t JOIN project_navigation_states s
      ON s.project_id = t.project_id AND s.state_id = t.state_id
      WHERE t.project_id = ${projectId} AND t.kind = 'name' AND t.term = ${normalized} AND t.environment = ${environment}
      ORDER BY t.state_id LIMIT ${ROUTE_BUDGET + 1}`;
    if (exact.length > 0)
      return {
        states: yield* Effect.forEach(exact.slice(0, ROUTE_BUDGET), (row) => stateJson(row.data)),
        truncated: exact.length > ROUTE_BUDGET,
      };
    const ids = new Set<string>();
    for (const word of navigationDestinationWords(normalized)) {
      const prefixes = Array.from({ length: word.length }, (_, i) => word.slice(0, i + 1)).filter(
        (prefix) => prefix.length >= Math.max(3, word.length - 3),
      );
      const prefix = word.slice(0, 5).replace(/[\uD800-\uDBFF]$/u, "");
      const fuzzy = word.length >= 3 && !/\p{N}/u.test(word);
      const rows = yield* sql<{ state_id: string }>`SELECT DISTINCT state_id FROM (
          SELECT state_id FROM project_navigation_terms WHERE project_id = ${projectId} AND environment = ${environment}
            AND kind = 'word' AND term IN ${sql.in(fuzzy && prefixes.length > 0 ? prefixes : [word])}
          UNION ALL SELECT state_id FROM project_navigation_terms WHERE project_id = ${projectId} AND environment = ${environment}
            AND kind = 'word' AND term >= ${prefix} AND term < ${prefix} || char(1114111) AND ${fuzzy ? 1 : 0}
            AND (${word.length >= 5 ? 1 : 0} OR length(term) <= ${word.length + 3})
        ) LIMIT ${ROUTE_BUDGET + 1}`;
      for (const row of rows) ids.add(row.state_id);
      if (ids.size > ROUTE_BUDGET) return { states: [], truncated: true };
    }
    if (ids.size === 0) return { states: [], truncated: false };
    const rows = yield* sql<{
      data: string;
    }>`SELECT data FROM project_navigation_states WHERE project_id = ${projectId}
      AND state_id IN ${sql.in([...ids])} ORDER BY state_id`;
    return {
      states: navigationDestinations(
        yield* Effect.forEach(rows, (row) => stateJson(row.data)),
        query,
      ),
      truncated: false,
    };
  }, Effect.mapError(failure));

  const findPath = Effect.fn("ProjectNavigationMemory.findPath")(function* (
    projectId: ProjectId,
    from: NavigationState,
    to: string,
    environment?: string,
  ) {
    if ((yield* getState(projectId, to)) === null)
      return { status: "no-route" as const, steps: [] };
    const key = (id: string, context: Readonly<Record<string, string>>) =>
      JSON.stringify([id, Object.entries(context).sort(([a], [b]) => a.localeCompare(b))]);
    const queue = [
      {
        state: from,
        context: from.context,
        steps: [] as Array<{ transition: NavigationTransition; destination: NavigationState }>,
      },
    ];
    const visited = new Set([key(from.id, from.context)]);
    let scanned = 0;
    let exhausted = false;
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index]!;
      if (current.state.id === to)
        return {
          status: current.steps.length === 0 ? ("already-there" as const) : ("found" as const),
          steps: current.steps,
        };
      if (index >= ROUTE_BUDGET) return { status: "budget-exhausted" as const, steps: [] };
      if (current.steps.length >= 50) {
        exhausted = true;
        continue;
      }
      const edges = yield* sql<ConnectionRow>`SELECT * FROM project_navigation_connections
        WHERE project_id = ${projectId} AND from_state_id = ${current.state.id}
        AND available = 1
        ORDER BY transition_id LIMIT ${ROUTE_BUDGET - scanned + 1}`;
      for (const row of edges) {
        if (scanned >= ROUTE_BUDGET) {
          exhausted = true;
          break;
        }
        scanned += 1;
        const edge = connection(row);
        if (!Object.entries(edge.conditions).every(([k, v]) => current.context[k] === v)) continue;
        const next = yield* getState(projectId, edge.to);
        if (next === null || (environment !== undefined && next.environment !== environment))
          continue;
        const context = { ...current.context, ...next.context };
        const nextKey = key(next.id, context);
        if (visited.has(nextKey)) continue;
        visited.add(nextKey);
        queue.push({
          state: next,
          context,
          steps: [...current.steps, { transition: edge, destination: next }],
        });
      }
    }
    return { status: exhausted ? ("budget-exhausted" as const) : ("no-route" as const), steps: [] };
  });
  const route = Effect.fn("ProjectNavigationMemory.navigationRoute")(function* (
    projectId: ProjectId,
    from: string,
    destination: string,
  ) {
    const start = yield* getState(projectId, from);
    if (start === null) return { status: "unrecognized" as const, candidates: [], steps: [] };
    const matches = yield* destinations(projectId, start.environment, destination);
    if (matches.truncated)
      return { status: "budget-exhausted" as const, candidates: [], steps: [] };
    const candidates = matches.states.filter((state) =>
      Object.entries(state.context).every(
        ([key, value]) => key === "authenticated" || start.context[key] === value,
      ),
    );
    if (candidates.length !== 1)
      return {
        status: candidates.length > 1 ? ("ambiguous" as const) : ("no-route" as const),
        candidates: candidates.slice(0, 8),
        steps: [],
      };
    const target = candidates[0]!;
    if (target.id === from && !isExactNavigationDestination(target, destination))
      return { status: "no-route" as const, candidates: [target], steps: [] };
    const result = yield* findPath(projectId, start, target.id, start.environment);
    return {
      ...result,
      candidates: [target],
      ...(target.id === from ? {} : { directUrl: `${target.environment}${target.path}` }),
    };
  }, Effect.mapError(failure));
  const navigationOverview = Effect.fn("ProjectNavigationMemory.navigationOverview")(function* (
    input: typeof NavigationOverviewInput.Type,
  ) {
    const limit = 200;
    // Stored cluster tables are deferred until the 1M benchmark shows GROUP BY is too slow.
    const clusters = yield* sql<{
      environment: string;
      pathGroup: string;
      stateCount: number;
      incomingCount: number;
      outgoingCount: number;
    }>`SELECT environment, path_group AS pathGroup,
      COUNT(*) AS stateCount, SUM(incoming_count) AS incomingCount, SUM(outgoing_count) AS outgoingCount FROM project_navigation_states
      WHERE project_id = ${input.projectId} GROUP BY environment, path_group ORDER BY environment, path_group LIMIT ${limit + 1}`;
    const connections = yield* sql<{
      fromEnvironment: string;
      fromPathGroup: string;
      toEnvironment: string;
      toPathGroup: string;
      count: number;
    }>`SELECT f.environment AS fromEnvironment, f.path_group AS fromPathGroup,
      t.environment AS toEnvironment, t.path_group AS toPathGroup, COUNT(*) AS count
      FROM project_navigation_connections c
      JOIN project_navigation_states f ON f.project_id = c.project_id AND f.state_id = c.from_state_id
      JOIN project_navigation_states t ON t.project_id = c.project_id AND t.state_id = c.to_state_id
      WHERE c.project_id = ${input.projectId}
      GROUP BY f.environment, f.path_group, t.environment, t.path_group
      ORDER BY count DESC, f.environment, f.path_group, t.environment, t.path_group LIMIT ${limit + 1}`;
    return {
      clusters: clusters.slice(0, limit),
      connections: connections.slice(0, limit),
      limit,
      truncated: clusters.length > limit || connections.length > limit,
    };
  }, Effect.mapError(failure));
  const statePage = Effect.fn("ProjectNavigationMemory.statePage")(function* (
    projectId: ProjectId,
    ids: ReadonlyArray<string>,
    limit: number,
  ) {
    const states = yield* Effect.forEach(ids.slice(0, limit), (id) => summary(projectId, id));
    return {
      states: states.filter((state) => state !== null),
      nextCursor: ids.length > limit ? pageCursor(ids[limit - 1]!) : null,
      limit,
      truncated: ids.length > limit,
    };
  });
  const navigationChildren = Effect.fn("ProjectNavigationMemory.navigationChildren")(function* (
    input: typeof NavigationChildrenInput.Type,
  ) {
    const limit = Math.max(1, Math.min(200, input.limit));
    const rows = yield* sql<{
      state_id: string;
    }>`SELECT state_id FROM project_navigation_states WHERE project_id = ${input.projectId}
      AND environment = ${input.environment} AND path_group = ${input.pathGroup} AND state_id > ${yield* cursorValue(input.cursor)} ORDER BY state_id LIMIT ${limit + 1}`;
    return yield* statePage(
      input.projectId,
      rows.map((row) => row.state_id),
      limit,
    );
  }, Effect.mapError(failure));
  const navigationNeighborhood = Effect.fn("ProjectNavigationMemory.navigationNeighborhood")(
    function* (input: typeof NavigationNeighborhoodInput.Type) {
      const limit = Math.max(1, Math.min(200, input.limit));
      const state = yield* summary(input.projectId, input.stateId);
      const filter = input.filter ?? "all";
      const available = sql`available = 1`;
      const predicate =
        filter === "all" ? sql`1` : filter === "available" ? available : sql`available = 0`;
      const incoming =
        state === null
          ? []
          : yield* sql<ConnectionRow>`SELECT * FROM project_navigation_connections
      WHERE project_id = ${input.projectId} AND to_state_id = ${input.stateId} AND ${predicate} ORDER BY transition_id LIMIT ${limit + 1}`;
      const outgoing =
        state === null
          ? []
          : yield* sql<ConnectionRow>`SELECT * FROM project_navigation_connections
      WHERE project_id = ${input.projectId} AND from_state_id = ${input.stateId} AND ${predicate} ORDER BY transition_id LIMIT ${limit + 1}`;
      const neighbors = Effect.fn("ProjectNavigationMemory.neighbors")(function* (
        rows: ReadonlyArray<ConnectionRow>,
        direction: "from_state_id" | "to_state_id",
      ) {
        const result = yield* Effect.forEach(rows.slice(0, limit), (row) =>
          summary(input.projectId, row[direction]).pipe(
            Effect.map((other) =>
              other === null ? [] : [{ transition: connection(row), state: other }],
            ),
          ),
        );
        return result.flat();
      });
      return {
        state,
        incoming: yield* neighbors(incoming, "from_state_id"),
        outgoing: yield* neighbors(outgoing, "to_state_id"),
        incomingTruncated: incoming.length > limit,
        outgoingTruncated: outgoing.length > limit,
        limit,
        truncated: incoming.length > limit || outgoing.length > limit,
      };
    },
    Effect.mapError(failure),
  );
  const navigationSearch = Effect.fn("ProjectNavigationMemory.navigationSearch")(function* (
    input: typeof NavigationSearchInput.Type,
  ) {
    const limit = Math.max(1, Math.min(50, input.limit));
    const query = input.query.trim().toLowerCase();
    const cursor = yield* cursorValue(input.cursor);
    // The subquery keeps short search on the term range before sorting by state cursor.
    const rows =
      [...query].length < 3
        ? yield* sql<{
            state_id: string;
          }>`SELECT DISTINCT state_id FROM (SELECT state_id FROM project_navigation_terms WHERE project_id = ${input.projectId} AND kind = 'word' AND term >= ${query} AND term < ${query} || char(1114111) LIMIT -1) WHERE state_id > ${cursor} ORDER BY state_id LIMIT ${limit + 1}`
        : yield* sql<{
            state_id: string;
          }>`SELECT s.state_id FROM project_navigation_search f CROSS JOIN project_navigation_states s ON s.rowid = f.rowid
        WHERE project_navigation_search MATCH ${`"${query.replaceAll('"', '""')}"`}
        AND s.project_id = ${input.projectId} AND s.state_id > ${cursor} ORDER BY s.state_id LIMIT ${limit + 1}`;
    return yield* statePage(
      input.projectId,
      rows.map((row) => row.state_id),
      limit,
    );
  }, Effect.mapError(failure));
  const navigationDetails = Effect.fn("ProjectNavigationMemory.navigationDetails")(function* (
    input: typeof NavigationDetailsInput.Type,
  ) {
    const state = yield* getState(input.projectId, input.stateId);
    const counts = yield* summary(input.projectId, input.stateId);
    const runs =
      state === null
        ? []
        : yield* sql<{
            runId: string;
            threadId: string;
            observedAt: string;
            scanned: number;
          }>`SELECT run_id AS runId, thread_id AS threadId, MAX(observed_at) AS observedAt, SUM(COUNT(*)) OVER () AS scanned
      FROM (SELECT run_id, thread_id, observed_at FROM project_navigation_observations
        WHERE project_id = ${input.projectId} AND state_id = ${input.stateId}
        ORDER BY observed_at DESC LIMIT ${ROUTE_BUDGET + 1})
      GROUP BY run_id, thread_id ORDER BY observedAt DESC, run_id, thread_id LIMIT 21`;
    return {
      state,
      incomingCount: counts?.incomingCount ?? 0,
      outgoingCount: counts?.outgoingCount ?? 0,
      runs: runs
        .slice(0, 20)
        .map(({ runId, threadId, observedAt }) => ({ runId, threadId, observedAt })),
      limit: 20,
      truncated: runs.length > 20 || (runs[0]?.scanned ?? 0) > ROUTE_BUDGET,
    };
  }, Effect.mapError(failure));
  const navigationRoutePreview = Effect.fn("ProjectNavigationMemory.navigationRoutePreview")(
    function* (input: typeof NavigationRoutePreviewInput.Type) {
      const start = yield* getState(input.projectId, input.fromStateId);
      const result =
        start === null
          ? { status: "no-route" as const, steps: [] }
          : yield* findPath(input.projectId, start, input.toStateId);
      const steps = yield* Effect.forEach(result.steps, (step) =>
        summary(input.projectId, step.destination.id).pipe(
          Effect.map((destination) =>
            destination === null ? [] : [{ transition: step.transition, destination }],
          ),
        ),
      );
      return {
        status: result.status,
        steps: steps.flat(),
        limit: ROUTE_BUDGET,
        truncated: result.status === "budget-exhausted",
      };
    },
    Effect.mapError(failure),
  );

  return ProjectNavigationMemory.of({
    statesAtAddress,
    destinations,
    navigationRoute: route,
    navigationOverview,
    navigationChildren,
    navigationNeighborhood,
    navigationSearch,
    navigationDetails,
    navigationRoutePreview,
    snapshot,
    observe: Effect.fn("ProjectNavigationMemory.observe")(function* (projectId, input) {
      const state = NavigationState.make({
        ...input.state,
        id: yield* hash(navigationStateKey(input.state)),
      });
      const observedAt = yield* now;
      const observationId = yield* random.uuidV4();
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const [existing] = yield* sql<{
            data: string;
          }>`SELECT data FROM project_navigation_states WHERE project_id = ${projectId} AND state_id = ${state.id}`;
          const remembered = existing === undefined ? null : yield* stateJson(existing.data);
          const stored =
            remembered === null
              ? state
              : {
                  ...state,
                  name: remembered.name,
                  aliases: [...new Set([...remembered.aliases, ...state.aliases, state.name])]
                    .filter((name) => name !== remembered.name)
                    .slice(0, 10),
                };
          const [previous] = yield* sql<{
            stateId: string;
            stepIndex: number;
          }>`SELECT state_id AS stateId, step_index AS stepIndex
          FROM project_navigation_observations WHERE project_id = ${projectId} AND run_id = ${input.runId}
          AND thread_id = ${input.threadId} AND tab_id = ${input.tabId} ORDER BY rowid DESC LIMIT 1`;
          const prior =
            previous === undefined
              ? undefined
              : (yield* sql<{ data: string }>`SELECT data FROM project_navigation_states
          WHERE project_id = ${projectId} AND state_id = ${previous.stateId}`)[0];
          const source = prior === undefined ? undefined : yield* stateJson(prior.data);
          const edge =
            source !== undefined &&
            previous !== undefined &&
            input.action !== undefined &&
            input.stepIndex > previous.stepIndex
              ? NavigationTransition.make({
                  id: yield* hash(navigationTransitionKey(source.id, state.id, input.action)),
                  from: source.id,
                  to: state.id,
                  action: input.action,
                  conditions: source.context,
                  runId: input.runId,
                  threadId: input.threadId,
                  observedAt,
                  available: true,
                })
              : null;
          yield* sql`INSERT INTO project_navigation_states (project_id, state_id, data) VALUES (${projectId}, ${state.id}, ${yield* encodeState(stored)})
          ON CONFLICT (project_id, state_id) DO UPDATE SET data = excluded.data`;
          yield* indexNavigationState(sql, projectId, stored);
          if (edge !== null) yield* storeNavigationConnection(sql, projectId, edge);
          yield* sql`INSERT INTO project_navigation_observations (observation_id, project_id, thread_id, run_id, tab_id, state_id, step_index, transition_json, observed_at, transition_id)
          VALUES (${observationId}, ${projectId}, ${input.threadId}, ${input.runId}, ${input.tabId}, ${state.id}, ${input.stepIndex}, ${edge === null ? null : yield* encodeTransition(edge)}, ${observedAt}, ${edge?.id ?? null})`;
          return NavigationState.make(stored);
        }),
      );
    }, Effect.mapError(failure)),
    feedback: Effect.fn("ProjectNavigationMemory.feedback")(function* (
      projectId,
      runId,
      transitionId,
      outcome,
    ) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const [known] =
            yield* sql`SELECT 1 FROM project_navigation_connections WHERE project_id = ${projectId} AND transition_id = ${transitionId}`;
          if (known === undefined)
            return yield* new ProjectMemoryError({ message: "Unknown navigation connection." });
          const observedAt = yield* now;
          yield* sql`INSERT INTO project_navigation_feedback (feedback_id, project_id, transition_id, run_id, outcome, observed_at)
          VALUES (${yield* random.uuidV4()}, ${projectId}, ${transitionId}, ${runId}, ${outcome}, ${observedAt})`;
          if (outcome === "mismatch")
            yield* sql`UPDATE project_navigation_connections SET last_mismatch_at = MAX(COALESCE(last_mismatch_at, ''), ${observedAt})
          WHERE project_id = ${projectId} AND transition_id = ${transitionId}`;
        }),
      );
    }, Effect.mapError(failure)),
    deleteRecord: Effect.fn("ProjectNavigationMemory.deleteRecord")(function* (projectId, id) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* preparePrune(sql);
          yield* sql`INSERT OR IGNORE INTO navigation_prune VALUES (${projectId}, ${id})`;
          let cursor = "";
          while (true) {
            const rows =
              yield* sql<ConnectionRow>`SELECT * FROM project_navigation_connections WHERE project_id = ${projectId}
              AND transition_id > ${cursor} AND transition_id IN (
                SELECT transition_id FROM (SELECT transition_id FROM project_navigation_connections WHERE project_id = ${projectId} AND from_state_id = ${id}
                  AND transition_id > ${cursor} ORDER BY transition_id LIMIT 500)
                UNION SELECT transition_id FROM (SELECT transition_id FROM project_navigation_connections WHERE project_id = ${projectId} AND to_state_id = ${id}
                  AND transition_id > ${cursor} ORDER BY transition_id LIMIT 500)
                UNION SELECT transition_id FROM project_navigation_connections WHERE project_id = ${projectId} AND transition_id = ${id})
              ORDER BY transition_id LIMIT 500`;
            if (rows.length === 0) break;
            for (const row of rows) {
              yield* sql`INSERT OR IGNORE INTO navigation_prune VALUES (${projectId}, ${row.from_state_id}), (${projectId}, ${row.to_state_id})`;
              yield* sql`DELETE FROM project_navigation_observations WHERE project_id = ${projectId} AND transition_id = ${row.transition_id}`;
              yield* sql`DELETE FROM project_navigation_feedback WHERE project_id = ${projectId} AND transition_id = ${row.transition_id}`;
              yield* rebuildNavigationConnection(sql, projectId, row.transition_id);
            }
            cursor = rows.at(-1)!.transition_id;
          }
          yield* sql`DELETE FROM project_navigation_observations WHERE project_id = ${projectId} AND state_id = ${id}`;
          yield* pruneStates(sql);
          yield* deleteNavigationState(sql, projectId, id);
        }),
      );
    }, Effect.mapError(failure)),
  });
});

export const layer = Layer.effect(ProjectNavigationMemory, make);
