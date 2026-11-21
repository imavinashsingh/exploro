import { assert, it } from "@effect/vitest";
import { ProjectId, NavigationState } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
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
