import {
  ProjectId,
  type ProjectMemoryFact,
  type ProjectUnderstandingItem,
  type ProjectMemoryMapBranch,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { buildProjectMap, formatProjectMap, seenNotTestedPages } from "./projectMap.ts";

const fact = (
  factId: string,
  route: string,
  overrides: Partial<ProjectMemoryFact> = {},
): ProjectMemoryFact => ({
  factId,
  route,
  projectId: ProjectId.make("shop"),
  environment: "https://shop.test",
  kind: "page",
  key: factId,
  value: factId,
  detail: null,
  pageUrl: null,
  evidence: [],
  appVersion: null,
  author: "agent",
  status: "current",
  observedAt: "2026-01-01T00:00:00Z",
  supersededBy: null,
  mayBeOutdated: false,
  ...overrides,
});
const pages = (
  branch: ProjectMemoryMapBranch,
): Array<NonNullable<ProjectMemoryMapBranch["page"]>> => [
  ...(branch.page === null ? [] : [branch.page]),
  ...branch.children.flatMap(pages),
];
const item = (
  kind: "dependency" | "workflow",
  citedFactIds: ReadonlyArray<string>,
): ProjectUnderstandingItem => ({
  itemId: kind,
  projectId: ProjectId.make("shop"),
  kind,
  statement: "signed-in session",
  status: "verified",
  author: "agent",
  version: 1,
  citedFactIds,
  dependsOn: [],
  needsReview: false,
  createdAt: "t",
  updatedAt: "t",
});

describe("project map", () => {
  it("groups route segments and environments, retains details and evidence, and computes coverage", () => {
    const control = fact("email", "/login", { kind: "control", value: "Email input" });
    const map = buildProjectMap([
      control,
      fact("pass", "/login", { kind: "result", value: "PASS" }),
      fact("fail", "/checkout", { kind: "result", value: "FAIL major" }),
      fact("pass2", "/checkout", { kind: "result", value: "PASS" }),
      fact("other", "/orders/:id"),
      fact("api", "/orders/:id", { kind: "api" }),
      fact("validation", "/login", { kind: "validation" }),
      fact("staging", "/login", { environment: "https://staging.shop.test" }),
      fact("old", "/old", { status: "superseded" }),
      fact("stale", "/stale", { status: "stale" }),
      fact("wrong", "/wrong", { status: "contradicted" }),
    ]);
    expect(map.environments.map((env) => env.environment)).toEqual([
      "https://shop.test",
      "https://staging.shop.test",
    ]);
    const tree = map.environments[0]!.tree;
    expect(tree.children.find((branch) => branch.name === "orders")?.children[0]?.route).toBe(
      "/orders/:id",
    );
    expect(
      pages(tree).map((page) => [page.route, page.coverage, page.passCount, page.failCount]),
    ).toEqual([
      ["/checkout", "failing", 1, 1],
      ["/login", "tested", 1, 0],
      ["/orders/:id", "seen", 0, 0],
    ]);
    expect(pages(tree)[1]?.details).toContainEqual(control);
    expect(seenNotTestedPages(map).map((page) => page.route)).toEqual(["/orders/:id", "/login"]);
    expect(buildProjectMap([]).environments).toEqual([]);
  });

  it("makes navigation-only pages and keeps looping links out of the route tree", () => {
    const map = buildProjectMap([
      fact("a", "/dashboard", { kind: "navigation", value: "/settings" }),
      fact("b", "/settings", { kind: "navigation", value: "/dashboard" }),
      fact("c", "/dashboard", { kind: "navigation", value: "/orders/123?sort=x" }),
      fact("d", "/dashboard", { kind: "navigation", value: "https://other.test/login" }),
      fact("e", "/settings", { kind: "result", value: "INCONCLUSIVE" }),
    ]);
    expect(seenNotTestedPages(map).map((page) => page.route)).toEqual([
      "/login",
      "/dashboard",
      "/orders/:id",
    ]);
    expect(pages(map.environments[1]!.tree)).toHaveLength(3);
    expect(formatProjectMap(map)).toContain("→ /dashboard");
    const arrow = buildProjectMap([
      fact("f", "/login", { kind: "navigation", value: "→ /dashboard (valid login)" }),
    ]);
    expect(pages(arrow.environments[0]!.tree).map((page) => page.route)).toEqual([
      "/dashboard",
      "/login",
    ]);
  });

  it("labels dependencies on cited current pages and preserves workflow citation order", () => {
    const map = buildProjectMap(
      [fact("a", "/login"), fact("b", "/dashboard"), fact("c", "/old", { status: "superseded" })],
      [item("dependency", ["a", "b", "c", "deleted"]), item("workflow", ["b", "a", "b", "c"])],
    );
    expect(pages(map.environments[0]!.tree).map((page) => page.needs)).toEqual([
      ["signed-in session"],
      ["signed-in session"],
    ]);
    expect(map.workflows[0]?.pages.map((page) => page.route)).toEqual(["/dashboard", "/login"]);
  });

  it("collapses branches after the first 50 names and caps text output", () => {
    const facts = Array.from({ length: 57 }, (_, index) =>
      fact(`${index}`, `/pages/p${String(index).padStart(2, "0")}`),
    );
    const map = buildProjectMap(facts.toReversed());
    const branch = map.environments[0]!.tree.children[0]!;
    expect(branch.children).toHaveLength(50);
    expect(branch.children[0]?.name).toBe("p00");
    expect(branch.children[49]?.name).toBe("p49");
    expect(branch.hiddenChildren).toBe(7);
    expect(formatProjectMap(map)).toContain("+7 more");
    expect(formatProjectMap(map, 300).length).toBeLessThanOrEqual(300);
    expect(formatProjectMap(map, 300)).toContain("map truncated");
  });
});
