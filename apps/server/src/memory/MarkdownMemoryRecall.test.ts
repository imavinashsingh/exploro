import { ProjectId, type NavigationState, type NavigationTransition } from "@t3tools/contracts";
import { it, expect } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Store from "./MarkdownMemoryStore.ts";
import * as Recall from "./MarkdownMemoryRecall.ts";
import * as ProjectMemory from "./ProjectMemory.ts";
import * as ProjectUnderstanding from "./ProjectUnderstanding.ts";
import * as MemoryEmbedder from "./MemoryEmbedder.ts";
import * as Navigation from "./ProjectNavigationMemory.ts";

const projectId = ProjectId.make("shop");
const environment = "https://shop.test";
it.effect(
  "recalls guides, searches non-verdict facts and separates screen issues from rules and outgoing connections",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* Store.MarkdownMemoryStore;
        const recall = yield* Recall.MarkdownMemoryRecall;
        const sql = yield* SqlClient.SqlClient;
        yield* store.saveUserDoc({
          projectId,
          kind: "guide",
          slug: "checkout",
          title: "Checkout",
          summary: "Cart",
          routes: ["/checkout"],
          keywords: ["cart"],
          body: "Needs cart",
          updatedAt: "2026-11-23",
        });
        const state: NavigationState = {
          id: "checkout",
          name: "Checkout",
          environment,
          path: "/checkout",
          aliases: [],
          context: {},
          checks: [{ kind: "textVisible", text: "Checkout" }],
        };
        yield* sql`INSERT INTO project_navigation_states (project_id, state_id, data, environment, path) VALUES (${projectId}, ${state.id}, ${JSON.stringify(state)}, ${environment}, ${state.path})`;
        const destination = { ...state, id: "payment", name: "Payment", path: "/payment" };
        yield* sql`INSERT INTO project_navigation_states (project_id, state_id, data, environment, path) VALUES (${projectId}, ${destination.id}, ${JSON.stringify(destination)}, ${environment}, ${destination.path})`;
        const transition: NavigationTransition = {
          id: "to-payment",
          from: state.id,
          to: "payment",
          action: "Continue",
          conditions: {},
          threadId: "t",
          runId: "r",
          observedAt: "2026-11-23",
          available: true,
        };
        yield* sql`INSERT INTO project_navigation_connections (project_id, transition_id, from_state_id, to_state_id, action, conditions_json, last_run_id, last_thread_id, last_observed_at, observation_count) VALUES (${projectId}, ${transition.id}, ${transition.from}, ${transition.to}, ${transition.action}, '{}', ${transition.runId}, ${transition.threadId}, ${transition.observedAt}, 1)`;
        for (const [id, kind, route, env, status, value] of [
          ["rule", "rule", "/checkout", environment, "current", "cart required"],
          ["failure", "result", "/checkout", environment, "current", "FAIL payment"],
          ["pass", "result", "/checkout", environment, "current", "PASS cart"],
          ["stale", "rule", "/checkout", environment, "stale", "cart stale"],
          ["staging", "rule", "/checkout", "https://staging.shop.test", "current", "cart staging"],
          ["elsewhere", "rule", "/other", environment, "current", "cart elsewhere"],
        ])
          yield* sql`INSERT INTO project_memory_facts (fact_id, project_id, state_id, environment, route, kind, fact_key, value, evidence_json, author, status, observed_at) VALUES (${id}, ${projectId}, ${state.id}, ${env}, ${route}, ${kind}, ${id}, ${value}, '[]', 'server', ${status}, '2026-11-23')`;
        expect((yield* recall.getGuide(projectId, "checkout")).guide?.body).toBe("Needs cart");
        expect((yield* recall.getGuide(ProjectId.make("other"), "checkout")).guide).toBeNull();
        const results = yield* recall.search(projectId, { query: "cart", environment });
        expect(results.docs).toHaveLength(1);
        expect(results.facts.map((fact) => fact.factId).sort()).toEqual(["elsewhere", "rule"]);
        const screen = yield* recall.forScreen(projectId, {
          route: `${environment}/checkout?step=1`,
        });
        expect(screen.guides).toHaveLength(1);
        expect(screen.facts.map((fact) => [fact.factId, fact.observedAt])).toEqual([
          ["rule", "2026-11-23"],
        ]);
        expect(screen.connections).toEqual([transition]);
        expect(screen.openIssuesLabel).toBe("Open issues from recent runs");
        expect(screen.openIssues.map((fact) => fact.factId)).toEqual(["failure"]);
        expect(
          (yield* recall.forScreen(ProjectId.make("other"), { route: "/checkout", environment }))
            .facts,
        ).toEqual([]);
      }),
    ).pipe(
      Effect.provide(
        Recall.layer.pipe(
          Layer.provideMerge(Store.layer),
          Layer.provideMerge(
            ProjectMemory.layer.pipe(
              Layer.provideMerge(Navigation.layer),
              Layer.provideMerge(
                ProjectUnderstanding.layer.pipe(Layer.provide(MemoryEmbedder.layerUnavailable)),
              ),
            ),
          ),
          Layer.provideMerge(Layer.fresh(Sqlite.layerMemory)),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "markdown-recall-" })),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
);
