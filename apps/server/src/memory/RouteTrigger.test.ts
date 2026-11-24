import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ThreadId,
  type MemoryDoc,
  type ProjectMemoryFact,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as MarkdownMemoryRecall from "./MarkdownMemoryRecall.ts";
import * as RouteTrigger from "./RouteTrigger.ts";

const shop = ProjectId.make("shop");
const guide: MemoryDoc = {
  docId: "shop:guide:checkout",
  projectId: shop,
  kind: "guide",
  slug: "checkout",
  title: "Checkout",
  summary: "A cart is required",
  status: "confirmed",
  routes: ["/checkout"],
  keywords: [],
  body: "Long body that the note leaves out.",
  updatedAt: "2026-11-23",
};
const issue = {
  factId: "fail-1",
  stateName: "Checkout",
  key: "Pay button does nothing",
  observedAt: "2026-11-22T00:00:00Z",
} as ProjectMemoryFact;

it.effect("attaches a route's guides and open issues once per thread and screen", () => {
  const lookups: Array<string> = [];
  return Effect.gen(function* () {
    const trigger = yield* RouteTrigger.RouteTrigger;
    const first = ThreadId.make("thread-1");
    const note = yield* trigger.onPage(first, "https://shop.test/checkout?step=1");
    expect(note).toContain('"Checkout" slug checkout, confirmed: "A cart is required"');
    expect(note).toContain("Open issues from recent runs, not rules");
    expect(note).toContain("Pay button does nothing");
    expect(note).not.toContain("Long body");
    // Clicks on the same screen, and a return to it, add nothing.
    expect(yield* trigger.onPage(first, "https://shop.test/checkout?step=2")).toBeNull();
    expect(yield* trigger.onPage(first, "https://shop.test/cart")).toBeNull();
    expect(yield* trigger.onPage(first, "https://shop.test/checkout")).toBeNull();
    // Another thread sees the same memory; other sites and non-web pages see none.
    expect(yield* trigger.onPage(ThreadId.make("thread-2"), "https://shop.test/checkout")).toBe(
      note,
    );
    expect(yield* trigger.onPage(first, "https://login.other.test/checkout")).toBeNull();
    expect(yield* trigger.onPage(first, "about:blank")).toBeNull();
    expect(lookups).toEqual([
      "https://shop.test/checkout?step=1",
      "https://shop.test/cart",
      "https://shop.test/checkout",
      "https://shop.test/checkout",
    ]);
  }).pipe(
    Effect.provide(
      RouteTrigger.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(MarkdownMemoryRecall.MarkdownMemoryRecall)({
              forScreen: (_projectId, input) =>
                Effect.sync(() => {
                  lookups.push(input.route);
                  const onCheckout = new URL(input.route).pathname === "/checkout";
                  return {
                    guides: onCheckout ? [guide] : [],
                    facts: [],
                    connections: [],
                    openIssuesLabel: "Open issues from recent runs" as const,
                    openIssues: onCheckout ? [issue] : [],
                  };
                }),
            }),
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadShell: () => Effect.succeed({ projectId: shop } as never),
            }),
            Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
              namedProjectsRoot: "/projects",
              isScratchProject: () => Effect.succeed(false),
            }),
            Layer.mock(ServerSettings.ServerSettingsService)({
              getSettings: Effect.succeed({
                ...DEFAULT_SERVER_SETTINGS,
                projectSettingsOverrides: {
                  [shop]: { qaMemoryEnabled: true, qaSiteOrigins: ["https://shop.test"] },
                },
              }),
            }),
          ),
        ),
      ),
    ),
  );
});
