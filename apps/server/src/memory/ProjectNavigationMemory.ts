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
  navigationStateKey,
  navigationTransitionKey,
} from "./navigation.ts";

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
const stateJson = Schema.decodeUnknownEffect(Schema.fromJsonString(NavigationState));
const transitionJson = Schema.decodeUnknownEffect(Schema.fromJsonString(NavigationTransition));

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

const deleteOrphanStates = (sql: SqlClient.SqlClient) =>
  sql`DELETE FROM project_navigation_states WHERE NOT EXISTS (
    SELECT 1 FROM project_navigation_observations o
    WHERE o.project_id = project_navigation_states.project_id AND o.state_id = project_navigation_states.state_id
  )`;

/** Runs inside the caller's transaction; states another run still observed stay. */
export const forgetNavigationRun = Effect.fn("ProjectNavigationMemory.forgetRun")(function* (
  sql: SqlClient.SqlClient,
  runId: string,
) {
  yield* sql`DELETE FROM project_navigation_feedback WHERE run_id = ${runId}`;
  yield* sql`DELETE FROM project_navigation_observations WHERE run_id = ${runId}`;
  yield* deleteOrphanStates(sql);
});

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
    }>`SELECT data FROM project_navigation_states WHERE project_id = ${projectId} AND EXISTS (
      SELECT 1 FROM project_navigation_observations o WHERE o.project_id = ${projectId} AND o.state_id = project_navigation_states.state_id
    ) ORDER BY state_id LIMIT 501`;
    const observations = yield* sql<{
      data: string;
    }>`SELECT transition_json AS data FROM project_navigation_observations
      WHERE project_id = ${projectId} AND transition_json IS NOT NULL ORDER BY rowid DESC LIMIT 1001`;
    const feedback = yield* sql<{
      transitionId: string;
      observedAt: string;
    }>`SELECT transition_id AS transitionId, MAX(observed_at) AS observedAt
      FROM project_navigation_feedback WHERE project_id = ${projectId} AND outcome = 'mismatch' GROUP BY transition_id`;
    const mismatches = new Map(feedback.map((row) => [row.transitionId, row.observedAt]));
    const transitions = new Map<string, NavigationTransition>();
    for (const row of observations.slice(0, 1000)) {
      const edge = yield* transitionJson(row.data);
      if (!transitions.has(edge.id))
        transitions.set(edge.id, {
          ...edge,
          available: (mismatches.get(edge.id) ?? "") < edge.observedAt,
        });
    }
    const decodedStates = yield* Effect.forEach(states.slice(0, 500), (row) => stateJson(row.data));
    const knownStates = new Set(decodedStates.map((state) => state.id));
    const knownEdges = [...transitions.values()].filter(
      (edge) => knownStates.has(edge.from) && knownStates.has(edge.to),
    );
    return NavigationSnapshot.make({
      states: decodedStates,
      transitions: knownEdges,
      truncated: states.length > 500 || observations.length > 1000,
    });
  }, Effect.mapError(failure));

  return ProjectNavigationMemory.of({
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
          yield* sql`INSERT INTO project_navigation_observations (observation_id, project_id, thread_id, run_id, tab_id, state_id, step_index, transition_json, observed_at)
          VALUES (${observationId}, ${projectId}, ${input.threadId}, ${input.runId}, ${input.tabId}, ${state.id}, ${input.stepIndex}, ${edge === null ? null : yield* encodeTransition(edge)}, ${observedAt})`;
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
      const known = (yield* snapshot(projectId)).transitions.find(
        (edge) => edge.id === transitionId,
      );
      if (known === undefined)
        return yield* new ProjectMemoryError({ message: "Unknown navigation connection." });
      yield* sql`INSERT INTO project_navigation_feedback (feedback_id, project_id, transition_id, run_id, outcome, observed_at)
        VALUES (${yield* random.uuidV4()}, ${projectId}, ${transitionId}, ${runId}, ${outcome}, ${yield* now})`;
    }, Effect.mapError(failure)),
    deleteRecord: Effect.fn("ProjectNavigationMemory.deleteRecord")(function* (projectId, id) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM project_navigation_observations WHERE project_id = ${projectId} AND (state_id = ${id}
          OR json_extract(transition_json, '$.id') = ${id} OR json_extract(transition_json, '$.from') = ${id} OR json_extract(transition_json, '$.to') = ${id})`;
          yield* sql`DELETE FROM project_navigation_states WHERE project_id = ${projectId} AND state_id = ${id}`;
          yield* deleteOrphanStates(sql);
        }),
      );
    }, Effect.mapError(failure)),
  });
});

export const layer = Layer.effect(ProjectNavigationMemory, make);
