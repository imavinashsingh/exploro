import { assert, it } from "@effect/vitest";
import { ProjectId, NavigationState } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { navigationDestinations } from "./navigation.ts";
import { rebuildNavigationConnection } from "./navigationStorage.ts";
import * as Navigation from "./ProjectNavigationMemory.ts";

const project = ProjectId.make("navigation-shop");
const other = ProjectId.make("other-project");
const state = (name: string, context: Record<string, string> = {}) =>
  NavigationState.make({
    id: "",
    name,
    context,
    environment: "https://shop.test",
    path: "/shared",
    aliases: [],
    checks: [{ kind: "textVisible", text: name }],
  });
const layer = Navigation.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(NodeCrypto.layer),
);

it.effect("learns connected paths with isolated history and feedback", () =>
  Effect.gen(function* () {
    const memory = yield* Navigation.ProjectNavigationMemory;
    const observe = (name: string, runId: string, stepIndex: number, action?: string) =>
      memory.observe(project, {
        state: state(name),
        threadId: "thread",
        runId,
        tabId: "tab",
        stepIndex,
        action,
      });
    const login = yield* observe("Login", "first", 0);
    const dashboard = yield* observe("Dashboard", "first", 1, "Sign in with provided credentials");
    const reused = yield* memory.observe(project, {
      state: { ...state("Dashboard"), name: "Home dashboard" },
      threadId: "thread",
      runId: "second",
      tabId: "tab",
      stepIndex: 0,
    });
    assert.strictEqual(reused.id, dashboard.id);
    assert.strictEqual(reused.name, "Dashboard");
    assert.deepStrictEqual(reused.aliases, ["Home dashboard"]);
    yield* observe("Applications", "second", 1, "Choose Applications");
    const form = yield* observe("New application", "second", 2, "Choose New application");
    const snapshot = yield* memory.snapshot(project);
    assert.strictEqual(Navigation.navigationRoute(snapshot, login.id, form.name).steps.length, 3);
    assert.strictEqual(
      Navigation.navigationRoute(snapshot, login.id, form.name).directUrl,
      "https://shop.test/shared",
    );
    assert.isUndefined(Navigation.navigationRoute(snapshot, form.id, form.name).directUrl);
    assert.strictEqual((yield* memory.snapshot(other)).states.length, 0);
    const edge = snapshot.transitions.find((edge) => edge.from === dashboard.id)!;
    const sql = yield* SqlClient.SqlClient;
    const filler = snapshot.transitions.find((edge) => edge.from === login.id)!;
    yield* sql`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < 1001)
      INSERT INTO project_navigation_observations
        (observation_id, project_id, thread_id, run_id, tab_id, state_id, step_index, transition_json, observed_at)
      SELECT 'filler-' || i, ${project}, 'thread', 'filler', 'tab', ${dashboard.id}, i,
        ${JSON.stringify(filler)}, ${filler.observedAt} FROM n`;
    yield* memory.feedback(project, "third", edge.id, "tool-error");
    yield* Navigation.forgetNavigationRun(sql, "filler");
    yield* TestClock.adjust("1 second");
    yield* memory.feedback(project, "third", edge.id, "tool-error");
    assert.isTrue(
      (yield* memory.snapshot(project)).transitions.find((e) => e.id === edge.id)!.available,
    );
    yield* memory.feedback(project, "third", edge.id, "mismatch");
    assert.strictEqual(
      Navigation.navigationRoute(yield* memory.snapshot(project), login.id, form.name).status,
      "no-route",
    );
    yield* TestClock.adjust("1 second");
    yield* observe("Dashboard", "fourth", 0);
    yield* observe("Applications", "fourth", 1, "Choose Applications");
    assert.strictEqual(
      Navigation.navigationRoute(yield* memory.snapshot(project), login.id, form.name).status,
      "found",
    );
    yield* memory.deleteRecord(other, dashboard.id);
    assert.strictEqual((yield* memory.snapshot(project)).states.length, 4);
    yield* memory.deleteRecord(project, dashboard.id);
    assert.strictEqual(
      Navigation.navigationRoute(yield* memory.snapshot(project), login.id, form.name).status,
      "no-route",
    );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "does not invent transitions without actions or across tabs, and keeps shared states",
  () =>
    Effect.gen(function* () {
      const memory = yield* Navigation.ProjectNavigationMemory;
      const observe = (name: string, tabId: string, stepIndex: number, action?: string) =>
        memory.observe(project, {
          state: state(name),
          threadId: "thread",
          runId: "run",
          tabId,
          stepIndex,
          action,
        });
      yield* observe("Dashboard", "tab-a", 0);
      yield* observe("Profile", "tab-a", 0, "Click");
      yield* observe("Editor", "tab-b", 1, "Edit");
      assert.strictEqual((yield* memory.snapshot(project)).transitions.length, 0);
      const settings = yield* observe("Settings", "tab-b", 2);
      yield* observe("Billing", "tab-b", 3, "Open billing");
      assert.deepStrictEqual(
        (yield* memory.snapshot(project)).transitions.map((edge) => edge.from),
        [settings.id],
      );
      const sql = yield* SqlClient.SqlClient;
      yield* memory.observe(project, {
        state: state("Dashboard"),
        threadId: "thread",
        runId: "kept",
        tabId: "tab-a",
        stepIndex: 0,
      });
      yield* sql`INSERT INTO project_memory_facts
        (fact_id, project_id, state_id, environment, route, kind, fact_key, value, evidence_json, author, status, observed_at)
        VALUES ('keep-fact', ${project}, ${settings.id}, 'https://shop.test', '/shared', 'page', 'purpose', 'Settings', '[]', 'agent', 'current', 'now')`;
      yield* Navigation.forgetNavigationRun(sql, "run");
      const remaining = yield* sql<{ name: string }>`
      SELECT json_extract(data, '$.name') AS name FROM project_navigation_states`;
      assert.deepStrictEqual(
        remaining.map((row) => row.name),
        ["Dashboard", "Settings"],
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("routes and accepts feedback beyond the snapshot observation and state caps", () =>
  Effect.gen(function* () {
    const memory = yield* Navigation.ProjectNavigationMemory;
    const sql = yield* SqlClient.SqlClient;
    const observe = (name: string, stepIndex: number, action?: string) =>
      memory.observe(project, {
        state: { ...state(name), path: `/screens/${name}` },
        threadId: "thread",
        runId: "large-run",
        tabId: "tab",
        stepIndex,
        action,
      });
    const start = yield* observe("Start", 0);
    const target = yield* observe("Destination", 1, "Open destination");
    const [edge] = (yield* memory.snapshot(project)).transitions;
    for (let index = 0; index < 1001; index += 1) yield* observe("Filler", index + 2, "Continue");
    yield* sql`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < 501)
      INSERT INTO project_navigation_states (project_id, state_id, data)
      SELECT ${project}, '!' || i, json_set(${JSON.stringify(start)}, '$.id', '!' || i, '$.path', '/filler/' || i) FROM n`;
    yield* sql`INSERT INTO project_navigation_observations
      (observation_id, project_id, thread_id, run_id, tab_id, state_id, step_index, observed_at)
      SELECT state_id, project_id, 'filler', 'filler', 'filler', state_id, 0, 'now'
      FROM project_navigation_states WHERE state_id LIKE '!%'`;
    assert.isTrue((yield* memory.snapshot(project)).truncated);
    assert.strictEqual(
      (yield* memory.statesAtAddress(project, start.environment, start.path))[0]?.id,
      start.id,
    );
    assert.strictEqual(
      (yield* memory.navigationRoute(project, start.id, target.name)).status,
      "found",
    );
    assert.strictEqual(
      (yield* memory.navigationRoutePreview({
        projectId: project,
        fromStateId: start.id,
        toStateId: target.id,
      })).status,
      "found",
    );
    yield* memory.feedback(project, "review", edge!.id, "mismatch");
    assert.strictEqual(
      (yield* memory.navigationRoute(project, start.id, target.name)).status,
      "no-route",
    );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "pages indexed explorer queries without duplicates and isolates every read by project",
  () =>
    Effect.gen(function* () {
      const memory = yield* Navigation.ProjectNavigationMemory;
      const ids: string[] = [];
      for (let index = 0; index < 7; index += 1) {
        ids.push(
          (yield* memory.observe(project, {
            state: {
              ...state(`Employee ${index}`),
              path: `/pim/view/${index}`,
              aliases: [`Person ${index}`],
            },
            threadId: "thread",
            runId: "run",
            tabId: "tab",
            stepIndex: index,
            ...(index === 0 ? {} : { action: "Next" }),
          })).id,
        );
      }
      const states = (yield* memory.snapshot(project)).states;
      for (const query of [
        "employee",
        "view employee",
        "person",
        "employee 3",
        "person 3",
        "employee 99",
        "the person",
      ]) {
        assert.deepStrictEqual(
          (yield* memory.destinations(project, "https://shop.test", query)).states
            .map((s) => s.id)
            .toSorted(),
          navigationDestinations(states, query)
            .map((s) => s.id)
            .toSorted(),
        );
      }
      for (const kind of ["children", "search", "short-prefix"] as const) {
        let cursor: string | undefined;
        const seen: string[] = [];
        do {
          const page =
            kind === "children"
              ? yield* memory.navigationChildren({
                  projectId: project,
                  environment: "https://shop.test",
                  pathGroup: "/pim",
                  limit: 2,
                  ...(cursor === undefined ? {} : { cursor }),
                })
              : yield* memory.navigationSearch({
                  projectId: project,
                  query: kind === "short-prefix" ? "pe" : "person",
                  limit: 2,
                  ...(cursor === undefined ? {} : { cursor }),
                });
          assert.strictEqual(page.limit, 2);
          assert.strictEqual(page.truncated, page.nextCursor !== null);
          seen.push(...page.states.map((s) => s.id));
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
        assert.deepStrictEqual(seen, [...ids].sort());
      }
      assert.strictEqual(
        (yield* memory.navigationSearch({ projectId: project, query: "0", limit: 50 })).states
          .length,
        1,
      );
      assert.strictEqual(
        (yield* memory.navigationSearch({ projectId: project, query: "/pim/view/3", limit: 50 }))
          .states[0]?.id,
        ids[3],
      );
      assert.strictEqual(
        (yield* Effect.result(
          memory.navigationChildren({
            projectId: project,
            environment: "https://shop.test",
            pathGroup: "/pim",
            cursor: "invalid",
            limit: 2,
          }),
        ))._tag,
        "Failure",
      );
      const overview = yield* memory.navigationOverview({ projectId: project });
      assert.deepStrictEqual(overview.clusters, [
        {
          environment: "https://shop.test",
          pathGroup: "/pim",
          stateCount: 7,
          incomingCount: 6,
          outgoingCount: 6,
        },
      ]);
      assert.strictEqual(overview.connections[0]?.count, 6);
      const neighbors = yield* memory.navigationNeighborhood({
        projectId: project,
        stateId: ids[3]!,
        limit: 1,
      });
      assert.strictEqual(neighbors.incoming[0]?.state.id, ids[2]);
      assert.strictEqual(neighbors.outgoing[0]?.state.id, ids[4]);
      const edge = neighbors.outgoing[0]!.transition;
      yield* memory.feedback(project, "review", edge.id, "mismatch");
      assert.strictEqual(
        (yield* memory.navigationNeighborhood({
          projectId: project,
          stateId: ids[3]!,
          limit: 1,
          filter: "available",
        })).outgoing.length,
        0,
      );
      assert.strictEqual(
        (yield* memory.navigationNeighborhood({
          projectId: project,
          stateId: ids[3]!,
          limit: 1,
          filter: "needs-recheck",
        })).outgoing.length,
        1,
      );
      assert.strictEqual(
        (yield* memory.navigationDetails({ projectId: project, stateId: ids[3]! })).runs.length,
        1,
      );
      assert.deepStrictEqual((yield* memory.navigationOverview({ projectId: other })).clusters, []);
      assert.deepStrictEqual(
        (yield* memory.navigationChildren({
          projectId: other,
          environment: "https://shop.test",
          pathGroup: "/pim",
          limit: 2,
        })).states,
        [],
      );
      assert.deepStrictEqual(
        (yield* memory.navigationSearch({ projectId: other, query: "person", limit: 2 })).states,
        [],
      );
      const isolated = yield* memory.navigationNeighborhood({
        projectId: other,
        stateId: ids[3]!,
        limit: 2,
      });
      assert.isNull(isolated.state);
      assert.deepStrictEqual(isolated.incoming, []);
      assert.deepStrictEqual(isolated.outgoing, []);
      assert.isNull(
        (yield* memory.navigationDetails({ projectId: other, stateId: ids[3]! })).state,
      );
      assert.strictEqual(
        (yield* memory.navigationRoutePreview({
          projectId: other,
          fromStateId: ids[0]!,
          toStateId: ids[6]!,
        })).status,
        "no-route",
      );
      assert.deepStrictEqual(
        yield* memory.statesAtAddress(other, "https://shop.test", "/pim/view/0"),
        [],
      );
      assert.deepStrictEqual(
        (yield* memory.destinations(other, "https://shop.test", "Employee 0")).states,
        [],
      );
      yield* memory.deleteRecord(project, ids[3]!);
      const after = yield* memory.navigationOverview({ projectId: project });
      assert.strictEqual(after.clusters[0]?.stateCount, 6);
      assert.strictEqual(after.connections[0]?.count, 4);
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(Navigation.forgetNavigationRun(sql, "review"));
      yield* sql.withTransaction(Navigation.forgetNavigationRun(sql, "run"));
      assert.deepStrictEqual(
        (yield* memory.navigationOverview({ projectId: project })).clusters,
        [],
      );
      assert.deepStrictEqual(
        (yield* memory.navigationSearch({ projectId: project, query: "person", limit: 2 })).states,
        [],
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("matches full-set destination ranking for word forms, numbers and Unicode", () =>
  Effect.gen(function* () {
    const memory = yield* Navigation.ProjectNavigationMemory;
    const states: NavigationState[] = [];
    for (const [index, name] of [
      "Add item",
      "Adding items",
      "Tracking orders",
      "Tracked orders",
      "Track order 12",
      "Tracking order 123",
      "Personal details editor",
      "Personnel details",
      "Überprüfung öffnen",
      "𐐀𐐁𐐂ing settings",
      "𐐀𐐁𐐂ed settings",
      "Screen view",
      "日本語設定",
      "Login",
    ].entries()) {
      states.push(
        yield* memory.observe(project, {
          state: {
            ...state(name),
            path: `/parity/${index}`,
            aliases: [name + " alias", "Shared destination"],
          },
          threadId: "thread",
          runId: "parity",
          tabId: "tab",
          stepIndex: index,
        }),
      );
    }
    for (const query of [
      ...states.flatMap((s) => [s.id, s.name, ...s.aliases]),
      "add",
      "adding",
      "tracked",
      "tracking",
      "track",
      "order 12",
      "order 123",
      "order 99",
      "my personal details editor",
      "person",
      "personnel",
      "überprüfung",
      "öffnen",
      "𐐀𐐁𐐂",
      "𐐀𐐁𐐂ing",
      "日本語",
      "view",
      "unknown",
      "log",
      "LOGIN",
      "  login  ",
    ]) {
      const result = yield* memory.destinations(project, "https://shop.test", query);
      assert.isFalse(result.truncated);
      assert.deepStrictEqual(
        result.states.map((s) => s.id).toSorted(),
        navigationDestinations(states, query)
          .map((s) => s.id)
          .toSorted(),
        query,
      );
    }
  }).pipe(Effect.provide(layer)),
);

it.effect("reports budget exhaustion for bounded graph expansion", () =>
  Effect.gen(function* () {
    const memory = yield* Navigation.ProjectNavigationMemory;
    const sql = yield* SqlClient.SqlClient;
    const observed: NavigationState[] = [];
    for (const name of ["Start", "Dead end", "Target"])
      observed.push(
        yield* memory.observe(project, {
          state: state(name),
          threadId: "thread",
          runId: name,
          tabId: "tab",
          stepIndex: 0,
        }),
      );
    const [start, dead, target] = observed;
    yield* sql`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < 2001)
      INSERT INTO project_navigation_connections (project_id, transition_id, from_state_id, to_state_id, action,
        conditions_json, last_run_id, last_thread_id, last_observed_at, observation_count)
      SELECT ${project}, 'edge-' || i, ${start!.id}, ${dead!.id}, 'Action ' || i, '{}', 'run', 'thread', 'now', 1 FROM n`;
    const route = yield* memory.navigationRoutePreview({
      projectId: project,
      fromStateId: start!.id,
      toStateId: target!.id,
    });
    assert.strictEqual(route.status, "budget-exhausted");
    assert.isTrue(route.truncated);
    assert.strictEqual(
      (yield* memory.navigationRoute(project, start!.id, target!.name)).status,
      "budget-exhausted",
    );
    const neighborhood = yield* memory.navigationNeighborhood({
      projectId: project,
      stateId: start!.id,
      limit: 200,
    });
    assert.strictEqual(neighborhood.outgoing.length, 200);
    assert.isTrue(neighborhood.outgoingTruncated);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "backfills indexed states, current connections and mismatch availability in batches",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 104 });
      const a = { ...state("Start"), id: "a", path: "/" };
      const b = {
        ...state("Employee"),
        id: "b",
        path: "/pim/view/1?tab=2#details",
        aliases: ["Person"],
      };
      for (const projectId of [project, other]) {
        for (const s of [a, b])
          yield* sql`INSERT INTO project_navigation_states VALUES (${projectId}, ${s.id}, ${JSON.stringify(s)})`;
        const edge = {
          id: "edge",
          from: a.id,
          to: b.id,
          action: "Open",
          conditions: {},
          runId: "early",
          threadId: "thread",
          observedAt: "2026-01-01",
          available: true,
        };
        yield* sql`INSERT INTO project_navigation_observations VALUES ('start-' || ${projectId}, ${projectId}, 'thread', 'early', 'tab', 'a', 0, NULL, '2026-01-01')`;
        yield* sql`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < 1001)
        INSERT INTO project_navigation_observations
        SELECT ${projectId} || '-' || i, ${projectId}, 'thread', 'early', 'tab', 'b', i, ${JSON.stringify(edge)}, '2026-01-01' FROM n`;
        yield* sql`INSERT INTO project_navigation_feedback VALUES ('feedback-' || ${projectId}, ${projectId}, 'edge', 'review', 'mismatch', '2026-01-02')`;
      }
      yield* runMigrations({ toMigrationInclusive: 105 });
      yield* Effect.gen(function* () {
        const memory = yield* Navigation.ProjectNavigationMemory;
        assert.deepStrictEqual((yield* memory.snapshot(project)).states, [a, b]);
        assert.isFalse((yield* memory.snapshot(project)).transitions[0]!.available);
        assert.deepStrictEqual(
          (yield* memory.navigationSearch({
            projectId: project,
            query: "person",
            limit: 50,
          })).states.map((s) => s.id),
          [b.id],
        );
        assert.strictEqual(
          (yield* memory.navigationChildren({
            projectId: project,
            environment: b.environment,
            pathGroup: "/pim",
            limit: 200,
          })).states[0]?.id,
          b.id,
        );
        const [count] = yield* sql<{
          observation_count: number;
        }>`SELECT observation_count FROM project_navigation_connections WHERE project_id = ${project} AND transition_id = 'edge'`;
        assert.strictEqual(count?.observation_count, 1001);
        const later = {
          id: "edge",
          from: a.id,
          to: b.id,
          action: "Open",
          conditions: {},
          runId: "later",
          threadId: "thread",
          observedAt: "2026-01-03",
          available: true,
        };
        yield* sql`INSERT INTO project_navigation_observations
        (observation_id, project_id, thread_id, run_id, tab_id, state_id, step_index, transition_json, observed_at, transition_id)
        VALUES ('latest', ${project}, 'thread', 'later', 'tab', 'b', 2, ${JSON.stringify(later)}, '2026-01-03', 'edge')`;
        yield* rebuildNavigationConnection(sql, project, "edge");
        assert.isTrue((yield* memory.snapshot(project)).transitions[0]!.available);
        assert.isFalse((yield* memory.snapshot(other)).transitions[0]!.available);
        yield* sql.withTransaction(Navigation.forgetNavigationRun(sql, "later"));
        assert.isFalse((yield* memory.snapshot(project)).transitions[0]!.available);
        const [restored] = yield* sql<{
          observation_count: number;
        }>`SELECT observation_count FROM project_navigation_connections WHERE project_id = ${project} AND transition_id = 'edge'`;
        assert.strictEqual(restored?.observation_count, 1001);
        yield* sql.withTransaction(Navigation.forgetNavigationRun(sql, "review"));
        assert.isTrue((yield* memory.snapshot(project)).transitions[0]!.available);
      }).pipe(Effect.provide(Navigation.layer.pipe(Layer.provide(NodeCrypto.layer))));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
