import * as MarkdownMemoryStore from "./MarkdownMemoryStore.ts";
import { ProjectId, QaSavedSecretId, type ProjectUnderstandingItem } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as QaSavedSecrets from "../qa/QaSavedSecrets.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectMemory from "./ProjectMemory.ts";
import * as ProjectMemoryAccess from "./ProjectMemoryAccess.ts";
import * as ProjectUnderstanding from "./ProjectUnderstanding.ts";

const shop = ProjectId.make("shop");
const off = ProjectId.make("off");
const navigationOnly = ProjectId.make("navigation-only");
const scratch = ProjectId.make("scratch");
const item = (
  kind: ProjectUnderstandingItem["kind"],
  statement: string,
): ProjectUnderstandingItem => ({
  itemId: `${kind}-1`,
  projectId: shop,
  kind,
  statement,
  status: "hypothesis",
  author: "agent",
  version: 1,
  citedFactIds: [],
  dependsOn: [],
  needsReview: false,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});
const account = item("account", "Sign in as qa@shop.test, an applicant account.");

const layer = ProjectMemoryAccess.layer.pipe(
  Layer.provide(
    Layer.mock(MarkdownMemoryStore.MarkdownMemoryStore)({
      migrateLegacyUnderstandingIfEmpty: () =>
        Effect.die("Active recall must not migrate legacy understanding"),
      syncProject: () => Effect.void,
      listDocs: () => Effect.succeed([]),
      matchDocsByRoutes: () => Effect.succeed([]),
      searchDocs: () =>
        Effect.succeed([
          {
            docId: "checkout",
            projectId: shop,
            kind: "guide",
            slug: "checkout",
            title: "Checkout",
            summary: "Cart",
            body: "Checkout needs a nonempty cart.",
            status: "confirmed",
            routes: [],
            keywords: [],
            updatedAt: "2026-11-23",
          },
        ]),
    }),
  ),
  Layer.provide(
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      isScratchProject: (projectId) => Effect.succeed(projectId === scratch),
    }),
  ),
  Layer.provide(
    ServerSettings.layerTest({
      projectSettingsOverrides: {
        [shop]: { qaSiteOrigins: ["https://shop.test"] },
        [off]: { qaMemoryEnabled: false, qaSiteOrigins: ["https://off.test"] },
        [navigationOnly]: { qaMemoryEnabled: true },
      },
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectMemory.ProjectMemory)({
      lookupFacts: () => Effect.succeed([]),
      map: () => Effect.succeed({ environments: [], hiddenEnvironments: 0, workflows: [] }),
      recordBriefUsage: () => Effect.void,
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectUnderstanding.ProjectUnderstanding)({
      contextItems: (projectId) => Effect.succeed(projectId === shop ? [account] : []),
    }),
  ),
  Layer.provide(
    Layer.mock(QaSavedSecrets.QaSavedSecrets)({
      list: Effect.succeed([
        {
          secretId: QaSavedSecretId.make("qa-secret-0a"),
          projectId: shop,
          label: "Shop password",
          site: "https://shop.test",
          savedAt: "2026-01-01T00:00:00Z",
        },
        {
          secretId: QaSavedSecretId.make("qa-secret-0b"),
          projectId: navigationOnly,
          label: "Other password",
          site: null,
          savedAt: "2026-01-01T00:00:00Z",
        },
      ]),
    }),
  ),
);

it.effect("gives memory only to projects that have it on", () =>
  Effect.gen(function* () {
    const access = yield* ProjectMemoryAccess.ProjectMemoryAccess;
    assert.isTrue(yield* access.hasMemory(shop));
    assert.isFalse(yield* access.hasMemory(off));
    assert.isFalse(yield* access.hasMemory(scratch));
    assert.isTrue(yield* access.hasMemory(navigationOnly));
    assert.include(
      yield* access.firstTurnBrief(navigationOnly, "Reach profile"),
      "Project Navigation Memory is enabled",
    );
    const brief = yield* access.firstTurnBrief(shop, "Test the new application form");
    assert.include(brief, "- https://shop.test");
    assert.include(brief, '- "Shop password" for https://shop.test: qa-secret-0a');
    assert.notInclude(brief, account.statement);
    assert.notInclude(brief, "qa-secret-0b");
    assert.strictEqual(brief.split("qa@shop.test").length, 1);
    assert.include(brief, "Checkout needs a nonempty cart.");
    // With memory off, the user's own setup still comes, but nothing learned does.
    const offBrief = yield* access.firstTurnBrief(off, "Test the dashboard");
    assert.include(offBrief, "- https://off.test");
    assert.notInclude(offBrief, "Navigation Memory");
    assert.strictEqual(yield* access.firstTurnBrief(scratch, "Test the dashboard"), "");
  }).pipe(Effect.provide(layer)),
);
