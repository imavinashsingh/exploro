import { memoryRoute } from "./projectMemoryFacts.ts";
import { makeMemoryEnvironmentResolver } from "./memoryEnvironment.ts";
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
  NavigationChildren,
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
import { bumpNavigationRevision } from "./navigationRevision.ts";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Latch from "effect/Latch";
import { NavigationRevision } from "@t3tools/contracts";
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
  navigationPathGroup,
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
  /** The tab whose action opened this one (a popup or `target=_blank` link). */
  readonly openerTabId?: string | undefined;
}

export class ProjectNavigationMemory extends Context.Service<
  ProjectNavigationMemory,
  {
    readonly notifyCommitted: () => Effect.Effect<void>;
    readonly subscribe: (
      projectId: ProjectId,
    ) => Stream.Stream<NavigationRevision, ProjectMemoryError>;
    readonly outgoingForScreen: (
      projectId: ProjectId,
      route: string,
      environment?: string,
    ) => Effect.Effect<ReadonlyArray<NavigationTransition>, ProjectMemoryError>;
    readonly statesAtAddress: (
      projectId: ProjectId,
      environment: string,
      path: string,
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
    ) => Effect.Effect<typeof NavigationChildren.Type, ProjectMemoryError>;
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
const decodeRevision = Schema.decodeEffect(Schema.fromJsonString(NavigationRevision));
const encodeState = Schema.encodeEffect(Schema.fromJsonString(NavigationState));
const encodeTransition = Schema.encodeEffect(Schema.fromJsonString(NavigationTransition));
const stateJson = Schema.decodeEffect(Schema.fromJsonString(NavigationState));
const decodeCursor = Schema.decodeEffect(Schema.fromJsonString(Schema.String));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

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
  const projects = yield* sql<{
    project_id: string;
  }>`SELECT DISTINCT project_id FROM project_navigation_observations WHERE run_id = ${runId} UNION SELECT project_id FROM project_navigation_feedback WHERE run_id = ${runId}`;
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
  for (const row of projects) {
    const states = yield* sql<{
      state_id: string;
    }>`SELECT p.state_id FROM navigation_prune p JOIN project_navigation_states s ON s.project_id = p.project_id AND s.state_id = p.state_id WHERE p.project_id = ${row.project_id} LIMIT 51`;
    yield* bumpNavigationRevision(
      sql,
      row.project_id,
      states.map((state) => state.state_id),
    );
  }
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
  const resolveEnvironment = yield* makeMemoryEnvironmentResolver;
  const changes = yield* PubSub.unbounded<{ projectId: string; event: NavigationRevision }>();
  const pending = yield* Latch.make();
  const notifyCommitted = Effect.fn("ProjectNavigationMemory.notifyCommitted")(() =>
    sql.afterCommit(Effect.asVoid(pending.open)),
  );
  let subscribers = 0;
  const publishPending = Effect.fn("ProjectNavigationMemory.publishPending")(function* () {
    const rows = yield* sql<{
      project_id: string;
      revision: number;
      hint: string;
    }>`SELECT project_id, revision, hint FROM project_navigation_revisions WHERE pending = 1`;
    if (rows.length === 0) return;
    yield* sql.withTransaction(
      Effect.forEach(
        rows,
        (row) =>
          sql`UPDATE project_navigation_revisions SET pending = 0 WHERE project_id = ${row.project_id} AND revision = ${row.revision}`,
        { discard: true },
      ),
    );
    for (const row of rows)
      yield* PubSub.publish(changes, {
        projectId: row.project_id,
        event: yield* decodeRevision(row.hint),
      });
  });
  yield* Effect.gen(function* () {
    yield* pending.await;
    yield* Effect.sleep("500 millis");
    yield* pending.close;
    if (subscribers > 0) yield* publishPending().pipe(Effect.ignore);
  }).pipe(Effect.forever, Effect.forkScoped);
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
    const [row] = yield* sql<{
      needsRecheck: number;
      name: string;
      environment: string;
      path: string;
      incomingCount: number;
      outgoingCount: number;
    }>`SELECT json_extract(data, '$.name') AS name, environment, path,
      (EXISTS(SELECT 1 FROM project_navigation_connections WHERE project_id = ${projectId} AND from_state_id = ${id} AND available = 0)
       OR EXISTS(SELECT 1 FROM project_navigation_connections WHERE project_id = ${projectId} AND to_state_id = ${id} AND available = 0)) AS needsRecheck,
      incoming_count AS incomingCount, outgoing_count AS outgoingCount
      FROM project_navigation_states WHERE project_id = ${projectId} AND state_id = ${id}`;
    if (row === undefined) return null;
    const { needsRecheck, ...fields } = row;
    return { id, ...fields, hasNeedsRecheck: needsRecheck === 1 } satisfies NavigationSummary;
  });
  const statesAtAddress = Effect.fn("ProjectNavigationMemory.statesAtAddress")(function* (
    projectId: ProjectId,
    environment: string,
    path: string,
  ) {
    const rows = yield* sql<{ data: string }>`SELECT data FROM project_navigation_states
      WHERE project_id = ${projectId} AND environment = ${environment} AND path = ${path}
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
    let batchEnd = 0;
    let batch: ReadonlyArray<ConnectionRow & { ordinal: number; destination_data: string | null }> =
      [];
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
      if (index >= batchEnd) {
        batchEnd = Math.min(queue.length, index + 128);
        const frontier = queue
          .slice(index, batchEnd)
          .map((item, offset) => ({ id: item.state.id, ordinal: index + offset }));
        batch = yield* sql<ConnectionRow & { ordinal: number; destination_data: string | null }>`
          SELECT c.*, CAST(json_extract(f.value, '$.ordinal') AS INTEGER) AS ordinal, s.data AS destination_data
          FROM json_each(${yield* encodeJson(frontier)}) f
          CROSS JOIN project_navigation_connections c ON c.rowid IN (
            SELECT rowid FROM project_navigation_connections
            WHERE project_id = ${projectId} AND from_state_id = json_extract(f.value, '$.id') AND available = 1
            ORDER BY transition_id LIMIT ${ROUTE_BUDGET - scanned + 1})
          LEFT JOIN project_navigation_states s ON s.project_id = c.project_id AND s.state_id = c.to_state_id
          ORDER BY ordinal, c.transition_id LIMIT ${ROUTE_BUDGET - scanned + 1}`;
      }
      const edges = batch.filter((row) => row.ordinal === index);
      for (const row of edges) {
        if (scanned >= ROUTE_BUDGET) {
          exhausted = true;
          break;
        }
        scanned += 1;
        const edge = connection(row);
        if (!Object.entries(edge.conditions).every(([k, v]) => current.context[k] === v)) continue;
        const next = row.destination_data === null ? null : yield* stateJson(row.destination_data);
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
    const clusters = yield* sql<{
      environment: string;
      pathGroup: string;
      stateCount: number;
      incomingCount: number;
      outgoingCount: number;
    }>`SELECT environment, path_group AS pathGroup, state_count AS stateCount,
      incoming_count AS incomingCount, outgoing_count AS outgoingCount FROM project_navigation_clusters
      WHERE project_id = ${input.projectId} ORDER BY environment, path_group LIMIT ${limit + 1}`;
    const connections = yield* sql<{
      fromEnvironment: string;
      fromPathGroup: string;
      toEnvironment: string;
      toPathGroup: string;
      count: number;
    }>`SELECT from_environment AS fromEnvironment, from_path_group AS fromPathGroup,
      to_environment AS toEnvironment, to_path_group AS toPathGroup, connection_count AS count
      FROM project_navigation_cluster_connections WHERE project_id = ${input.projectId}
      ORDER BY count DESC, from_environment, from_path_group, to_environment, to_path_group LIMIT ${limit + 1}`;
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
    const scope = yield* encodeJson([input.environment, input.pathGroup, input.prefix ?? null]);
    const decoded = yield* cursorValue(input.cursor);
    if (decoded && !decoded.startsWith(`${scope}\n`))
      return yield* new ProjectMemoryError({ message: "Invalid children cursor scope" });
    const cursor = decoded ? decoded.slice(scope.length + 1) : "";
    const [first] = yield* sql<{ path: string }>`SELECT path FROM project_navigation_states
      WHERE project_id = ${input.projectId} AND environment = ${input.environment}
      AND path_group = ${input.pathGroup} ORDER BY state_id LIMIT 1`;
    const parts = first?.path.split(/[?#]/u)[0]!.split("/").filter(Boolean) ?? [];
    const controller = parts.findIndex((segment) => segment.includes("."));
    let prefix = input.prefix ?? `/${parts.slice(0, controller + 2).join("/")}`;
    if (
      input.prefix !== undefined &&
      (!input.prefix.startsWith("/") ||
        input.prefix.includes("?") ||
        navigationPathGroup(input.prefix) !== input.pathGroup)
    )
      return yield* new ProjectMemoryError({ message: "Invalid children prefix" });
    const root = input.prefix === undefined;
    const predicate = () =>
      root
        ? sql`path_group = ${input.pathGroup}`
        : sql`path_group = ${input.pathGroup} AND (path = ${prefix} OR path >= ${prefix + "/"} AND path < ${prefix + "/" + String.fromCodePoint(0x10ffff)} OR path >= ${prefix + "?"} AND path < ${prefix + "?" + String.fromCodePoint(0x10ffff)} OR path >= ${prefix + "#"} AND path < ${prefix + "#" + String.fromCodePoint(0x10ffff)})`;
    const [size] = yield* sql<{ count: number }>`SELECT count(*) AS count FROM
      (SELECT 1 FROM project_navigation_states WHERE project_id = ${input.projectId}
      AND environment = ${input.environment} AND ${predicate()} LIMIT 41)`;
    if (!cursor && (size?.count ?? 0) > 40) {
      // Address-index seeks skip whole segments; neither DISTINCT nor GROUP BY scans the cluster.
      while (true) {
        const base = prefix.endsWith("/") ? prefix : `${prefix}/`;
        let after = base;
        const groups: Array<{ prefix: string; stateCount: number; countCapped: boolean }> = [];
        let more = false;
        const seen = new Set<string>();
        while (groups.length <= 200) {
          const [next] = yield* sql<{ path: string }>`SELECT path FROM project_navigation_states
            WHERE project_id = ${input.projectId} AND environment = ${input.environment}
            AND path > ${after} AND path < ${base + String.fromCodePoint(0x10ffff)} ORDER BY path LIMIT 1`;
          if (!next) break;
          const segment = next.path.slice(base.length).split(/[/?#]/u)[0]!;
          const child = base + segment;
          if (seen.has(child)) {
            after = child + next.path.charAt(child.length) + String.fromCodePoint(0x10ffff);
            continue;
          }
          seen.add(child);
          const [count] = yield* sql<{ count: number }>`SELECT count(*) AS count FROM
            (SELECT 1 FROM project_navigation_states WHERE project_id = ${input.projectId}
            AND environment = ${input.environment} AND path >= ${child}
            AND path < ${child + String.fromCodePoint(0x10ffff)}
            AND (path = ${child} OR path >= ${child + "/"} AND path < ${child + "/" + String.fromCodePoint(0x10ffff)} OR path >= ${child + "?"} AND path < ${child + "?" + String.fromCodePoint(0x10ffff)} OR path >= ${child + "#"} AND path < ${child + "#" + String.fromCodePoint(0x10ffff)}) LIMIT 10001)`;
          groups.push({
            prefix: child,
            stateCount: Math.min(10000, count?.count ?? 0),
            countCapped: (count?.count ?? 0) > 10000,
          });
          after = child;
          if (groups.length > 200) {
            more = true;
            break;
          }
        }
        if (groups.length > 1) {
          const visible = groups.slice(0, 200);
          const singles = visible.filter((group) => group.stateCount === 1);
          const direct = yield* Effect.forEach(singles, (group) =>
            Effect.gen(function* () {
              const [row] = yield* sql<{
                state_id: string;
              }>`SELECT state_id FROM project_navigation_states
                WHERE project_id = ${input.projectId} AND environment = ${input.environment}
                AND (path = ${group.prefix} OR path >= ${group.prefix + "/"} AND path < ${group.prefix + "/" + String.fromCodePoint(0x10ffff)} OR path >= ${group.prefix + "?"} AND path < ${group.prefix + "?" + String.fromCodePoint(0x10ffff)} OR path >= ${group.prefix + "#"} AND path < ${group.prefix + "#" + String.fromCodePoint(0x10ffff)}) LIMIT 1`;
              return row ? yield* summary(input.projectId, row.state_id) : null;
            }),
          );
          const terminals = yield* sql<{
            state_id: string;
          }>`SELECT state_id FROM project_navigation_states
            WHERE project_id = ${input.projectId} AND environment = ${input.environment}
            AND path = ${prefix} ORDER BY state_id LIMIT 200`;
          const terminalStates = yield* Effect.forEach(terminals, (row) =>
            summary(input.projectId, row.state_id),
          );
          return {
            kind: "subgroups" as const,
            subgroups: visible.filter((group) => group.stateCount > 1),
            states: [...terminalStates, ...direct].filter((state) => state !== null),
            nextCursor: null,
            limit: 200,
            truncated: more,
          };
        }
        if (groups.length === 0) break;
        const [terminal] =
          yield* sql`SELECT 1 FROM project_navigation_states WHERE project_id = ${input.projectId}
          AND environment = ${input.environment} AND path = ${prefix} LIMIT 1`;
        if (terminal) break;
        prefix = groups[0]!.prefix;
      }
    }
    const rows = yield* sql<{ state_id: string }>`SELECT state_id FROM project_navigation_states
      WHERE project_id = ${input.projectId} AND environment = ${input.environment}
      AND ${predicate()} AND state_id > ${cursor} ORDER BY state_id LIMIT ${limit + 1}`;
    const page = yield* statePage(
      input.projectId,
      rows.map((row) => row.state_id),
      limit,
    );
    const ids = page.states.map((state) => state.id);
    const edges =
      ids.length === 0
        ? []
        : yield* sql<ConnectionRow>`SELECT * FROM project_navigation_connections
      WHERE project_id = ${input.projectId} AND from_state_id IN ${sql.in(ids)} AND to_state_id IN ${sql.in(ids)}
      ORDER BY from_state_id, to_state_id, transition_id LIMIT 501`;
    return {
      ...page,
      kind: "states" as const,
      nextCursor: rows.length > limit ? pageCursor(`${scope}\n${rows[limit - 1]!.state_id}`) : null,
      connections: edges.slice(0, 500).map(connection),
      connectionsTruncated: edges.length > 500,
    };
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
    const short = [...query].length < 3;
    const match = `"${query.replaceAll('"', '""')}"`;
    // Dense matches can stop in cursor order; sparse matches use the inverted index below.
    const probe = yield* sql<{ state_id: string }>`SELECT s.state_id FROM
      (SELECT rowid, state_id FROM project_navigation_states WHERE project_id = ${input.projectId}
        AND state_id > ${cursor} ORDER BY state_id LIMIT 256) s
      WHERE ${
        short
          ? sql`EXISTS (SELECT 1 FROM project_navigation_terms t WHERE t.project_id = ${input.projectId}
            AND t.state_id = s.state_id AND t.kind = 'word' AND t.term >= ${query} AND t.term < ${query} || char(1114111))`
          : sql`EXISTS (SELECT 1 FROM project_navigation_search f WHERE f.rowid = s.rowid AND project_navigation_search MATCH ${match})`
      }
      ORDER BY s.state_id LIMIT ${limit + 1}`;
    const rows =
      probe.length > limit
        ? probe
        : [...query].length < 3
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
    const [recheck] = yield* sql<{ count: number }>`SELECT count(*) AS count FROM
      (SELECT transition_id FROM project_navigation_connections WHERE project_id = ${input.projectId}
        AND from_state_id = ${input.stateId} AND available = 0
       UNION SELECT transition_id FROM project_navigation_connections WHERE project_id = ${input.projectId}
        AND to_state_id = ${input.stateId} AND available = 0)`;
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
      needsRecheckCount: recheck?.count ?? 0,
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
    outgoingForScreen: Effect.fn("ProjectNavigationMemory.outgoingForScreen")(function* (
      projectId,
      route,
      environment,
    ) {
      const scope = yield* resolveEnvironment(projectId, environment);
      const states = yield* sql<{
        state_id: string;
        path: string;
      }>`SELECT state_id, path FROM project_navigation_states
        WHERE project_id = ${projectId} AND (${scope.appliedEnvironment} IS NULL OR ${sql.in("environment", scope.environments)})`;
      const ids = states
        .filter((state) => memoryRoute(state.path) === memoryRoute(route))
        .map((state) => state.state_id);
      if (ids.length === 0) return [];
      const rows = yield* sql<ConnectionRow>`SELECT * FROM project_navigation_connections
        WHERE project_id = ${projectId} AND from_state_id IN ${sql.in(ids)} ORDER BY last_observed_at DESC, transition_id`;
      return rows.map(connection);
    }, Effect.mapError(failure)),
    notifyCommitted,
    subscribe: (projectId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              subscribers += 1;
              pending.openUnsafe();
            }),
            () =>
              Effect.sync(() => {
                subscribers -= 1;
              }),
          );
          const [row] = yield* sql<{
            revision: number;
          }>`SELECT revision FROM project_navigation_revisions WHERE project_id = ${projectId}`.pipe(
            Effect.mapError(failure),
          );
          const revision = row?.revision ?? 0;
          return Stream.concat(
            Stream.succeed({ revision, clusters: [], stateIds: [], all: true }),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter(
                (item) => item.projectId === projectId && item.event.revision > revision,
              ),
              Stream.map((item) => item.event),
            ),
          );
        }),
      ),
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
          const latestIn = (tabId: string) => sql<{
            stateId: string;
            stepIndex: number;
          }>`SELECT state_id AS stateId, step_index AS stepIndex
          FROM project_navigation_observations WHERE project_id = ${projectId} AND run_id = ${input.runId}
          AND thread_id = ${input.threadId} AND tab_id = ${tabId} ORDER BY rowid DESC LIMIT 1`;
          const [inTab] = yield* latestIn(input.tabId);
          // A new tab's first screen continues from the screen whose action opened it. Tabs are
          // separate timelines, so the step order check applies within one tab only.
          const [opened] =
            inTab === undefined &&
            input.openerTabId !== undefined &&
            input.openerTabId !== input.tabId &&
            input.action !== undefined
              ? yield* latestIn(input.openerTabId)
              : [];
          const previous = inTab ?? opened;
          const prior =
            previous === undefined
              ? undefined
              : (yield* sql<{ data: string }>`SELECT data FROM project_navigation_states
          WHERE project_id = ${projectId} AND state_id = ${previous.stateId}`)[0];
          const source = prior === undefined ? undefined : yield* stateJson(prior.data);
          const edge =
            source !== undefined &&
            source.id !== state.id &&
            previous !== undefined &&
            input.action !== undefined &&
            (opened !== undefined || input.stepIndex > previous.stepIndex)
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
          yield* indexNavigationState(sql, projectId, stored, remembered === null);
          if (edge !== null) yield* storeNavigationConnection(sql, projectId, edge);
          yield* sql`INSERT INTO project_navigation_observations (observation_id, project_id, thread_id, run_id, tab_id, state_id, step_index, transition_json, observed_at, transition_id)
          VALUES (${observationId}, ${projectId}, ${input.threadId}, ${input.runId}, ${input.tabId}, ${state.id}, ${input.stepIndex}, ${edge === null ? null : yield* encodeTransition(edge)}, ${observedAt}, ${edge?.id ?? null})`;
          yield* bumpNavigationRevision(sql, projectId, [state.id, ...(source ? [source.id] : [])]);
          yield* notifyCommitted();
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
          const [known] = yield* sql<{
            from_state_id: string;
            to_state_id: string;
          }>`SELECT from_state_id, to_state_id FROM project_navigation_connections WHERE project_id = ${projectId} AND transition_id = ${transitionId}`;
          if (known === undefined)
            return yield* new ProjectMemoryError({ message: "Unknown navigation connection." });
          yield* bumpNavigationRevision(sql, projectId, [known.from_state_id, known.to_state_id]);
          const observedAt = yield* now;
          yield* sql`INSERT INTO project_navigation_feedback (feedback_id, project_id, transition_id, run_id, outcome, observed_at)
          VALUES (${yield* random.uuidV4()}, ${projectId}, ${transitionId}, ${runId}, ${outcome}, ${observedAt})`;
          if (outcome === "mismatch")
            yield* sql`UPDATE project_navigation_connections SET last_mismatch_at = MAX(COALESCE(last_mismatch_at, ''), ${observedAt})
          WHERE project_id = ${projectId} AND transition_id = ${transitionId}`;
          yield* notifyCommitted();
        }),
      );
    }, Effect.mapError(failure)),
    deleteRecord: Effect.fn("ProjectNavigationMemory.deleteRecord")(function* (projectId, id) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* preparePrune(sql);
          yield* sql`INSERT OR IGNORE INTO navigation_prune VALUES (${projectId}, ${id})`;
          yield* sql`CREATE TEMP TABLE IF NOT EXISTS navigation_delete_edges (
            transition_id TEXT PRIMARY KEY, from_state_id TEXT NOT NULL, to_state_id TEXT NOT NULL) WITHOUT ROWID`;
          yield* sql`DELETE FROM navigation_delete_edges`;
          // A UNION lets SQLite scan the project to merge in transition order instead of seeking each endpoint.
          for (const column of ["from_state_id", "to_state_id", "transition_id"] as const)
            yield* sql`INSERT OR IGNORE INTO navigation_delete_edges
              SELECT transition_id, from_state_id, to_state_id FROM project_navigation_connections
              WHERE project_id = ${projectId} AND ${sql(column)} = ${id}`;
          yield* sql`INSERT OR IGNORE INTO navigation_prune
            SELECT ${projectId}, from_state_id FROM navigation_delete_edges
            UNION SELECT ${projectId}, to_state_id FROM navigation_delete_edges`;
          const affected = yield* sql<{
            state_id: string;
          }>`SELECT p.state_id FROM navigation_prune p JOIN project_navigation_states s ON s.project_id = p.project_id AND s.state_id = p.state_id WHERE p.project_id = ${projectId} LIMIT 51`;
          yield* bumpNavigationRevision(
            sql,
            projectId,
            affected.map((row) => row.state_id),
          );
          // Rowid lookups keep the UPDATE planner from scanning every state in the project.
          yield* sql`UPDATE project_navigation_states SET outgoing_count = outgoing_count - d.count
            FROM (SELECT from_state_id AS id, COUNT(*) AS count FROM navigation_delete_edges GROUP BY from_state_id) d
            WHERE rowid = (SELECT rowid FROM project_navigation_states
              WHERE project_id = ${projectId} AND state_id = d.id)`;
          yield* sql`UPDATE project_navigation_states SET incoming_count = incoming_count - d.count
            FROM (SELECT to_state_id AS id, COUNT(*) AS count FROM navigation_delete_edges GROUP BY to_state_id) d
            WHERE rowid = (SELECT rowid FROM project_navigation_states
              WHERE project_id = ${projectId} AND state_id = d.id)`;
          for (const direction of ["from_state_id", "to_state_id"] as const) {
            const column =
              direction === "from_state_id" ? sql`outgoing_count` : sql`incoming_count`;
            yield* sql`UPDATE project_navigation_clusters SET ${column} = ${column} - d.count
              FROM (SELECT s.environment, s.path_group, COUNT(*) AS count FROM navigation_delete_edges e
                CROSS JOIN project_navigation_states s ON s.project_id = ${projectId} AND s.state_id = ${direction === "from_state_id" ? sql`e.from_state_id` : sql`e.to_state_id`}
                GROUP BY s.environment, s.path_group) d
              WHERE project_id = ${projectId} AND project_navigation_clusters.environment = d.environment
                AND project_navigation_clusters.path_group = d.path_group`;
          }
          yield* sql`UPDATE project_navigation_cluster_connections SET connection_count = connection_count - d.count
            FROM (SELECT f.environment AS fe, f.path_group AS fp, t.environment AS te, t.path_group AS tp, COUNT(*) AS count
              FROM navigation_delete_edges e
              CROSS JOIN project_navigation_states f ON f.project_id = ${projectId} AND f.state_id = e.from_state_id
              CROSS JOIN project_navigation_states t ON t.project_id = ${projectId} AND t.state_id = e.to_state_id
              GROUP BY f.environment, f.path_group, t.environment, t.path_group) d
            WHERE project_id = ${projectId} AND from_environment = d.fe AND from_path_group = d.fp
              AND to_environment = d.te AND to_path_group = d.tp`;
          yield* sql`DELETE FROM project_navigation_cluster_connections WHERE project_id = ${projectId} AND connection_count = 0`;
          yield* sql`DELETE FROM project_navigation_observations WHERE rowid IN (
            SELECT o.rowid FROM navigation_delete_edges e CROSS JOIN project_navigation_observations o
              ON o.project_id = ${projectId} AND o.transition_id = e.transition_id)`;
          yield* sql`DELETE FROM project_navigation_feedback WHERE rowid IN (
            SELECT f.rowid FROM navigation_delete_edges e CROSS JOIN project_navigation_feedback f
              ON f.project_id = ${projectId} AND f.transition_id = e.transition_id)`;
          yield* sql`DELETE FROM project_navigation_connections WHERE rowid IN (
            SELECT c.rowid FROM navigation_delete_edges e CROSS JOIN project_navigation_connections c
              ON c.project_id = ${projectId} AND c.transition_id = e.transition_id)`;
          yield* sql`DELETE FROM project_navigation_observations WHERE project_id = ${projectId} AND state_id = ${id}`;
          yield* pruneStates(sql);
          yield* deleteNavigationState(sql, projectId, id);
          yield* notifyCommitted();
        }),
      );
    }, Effect.mapError(failure)),
  });
});

export const layer = Layer.effect(ProjectNavigationMemory, make);
