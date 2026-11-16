import {
  ProjectId,
  type ProjectMemoryFact,
  type ProjectMemoryMap,
  type ProjectMemoryMapBranch,
  type ProjectMemoryMapPage,
  type ProjectMemoryStatus,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_FACT_FILTER,
  factFilterOptions,
  factVersions,
  filterFacts,
  mapCoverageLabel,
  mapRows,
  memoryStatusLine,
} from "./projectMemory.ts";

const fact = (factId: string, overrides: Partial<ProjectMemoryFact> = {}): ProjectMemoryFact => ({
  factId,
  projectId: ProjectId.make("shop"),
  environment: "https://shop.test",
  route: "/login",
  kind: "validation",
  key: "empty email",
  value: factId,
  detail: null,
  pageUrl: null,
  evidence: [],
  appVersion: null,
  author: "agent",
  status: "current",
  observedAt: "2026-01-02T00:00:00Z",
  supersededBy: null,
  mayBeOutdated: false,
  ...overrides,
});

describe("facts", () => {
  const facts = [
    fact("new"),
    fact("old", { status: "superseded", supersededBy: "new", observedAt: "2026-01-01T00:00:00Z" }),
    fact("other-key", { key: "wrong password" }),
    fact("admin", { environment: "https://admin.test", route: "/users" }),
  ];

  it("shows current facts by default and lists each fact's versions newest first", () => {
    expect(filterFacts(facts, EMPTY_FACT_FILTER).map((entry) => entry.factId)).toEqual([
      "new",
      "other-key",
      "admin",
    ]);
    expect(factVersions(facts, facts[0]!).map((entry) => entry.factId)).toEqual(["new", "old"]);
  });

  it("narrows routes to the chosen environment", () => {
    const filter = { ...EMPTY_FACT_FILTER, environment: "https://admin.test" };
    expect(factFilterOptions(facts, filter).routes).toEqual(["/users"]);
    expect(filterFacts(facts, { ...filter, status: null }).map((entry) => entry.factId)).toEqual([
      "admin",
    ]);
  });
});

describe("memoryStatusLine", () => {
  const status: ProjectMemoryStatus = {
    recall: "text",
    recallNote: null,
    pendingExtractions: 0,
    failedExtractions: [],
  };
  it.each([
    [status, true, "ready"],
    [{ ...status, pendingExtractions: 2 }, true, "busy"],
    [
      { ...status, pendingExtractions: 2, failedExtractions: [{ runId: "r", error: "x" }] },
      true,
      "failed",
    ],
    [status, false, "off"],
  ] as const)("%o enabled=%s is %s", (input, enabled, tone) => {
    expect(memoryStatusLine(input, enabled).tone).toBe(tone);
  });
});

describe("map rows", () => {
  const page = (route: string, overrides: Partial<ProjectMemoryMapPage> = {}) => ({
    environment: "https://shop.test",
    route,
    coverage: "seen" as const,
    passCount: 0,
    failCount: 0,
    facts: [],
    details: [],
    navigation: [],
    needs: [],
    ...overrides,
  });
  const branch = (
    route: string,
    overrides: Partial<ProjectMemoryMapBranch> = {},
  ): ProjectMemoryMapBranch => ({
    name: route.split("/").at(-1) ?? "",
    route,
    page: page(route),
    children: [],
    hiddenChildren: 0,
    ...overrides,
  });
  const map: ProjectMemoryMap = {
    environments: [
      {
        environment: "https://shop.test",
        tree: branch("/", {
          name: "/",
          children: [
            branch("/orders", { page: null, children: [branch("/orders/:id")], hiddenChildren: 3 }),
          ],
        }),
      },
    ],
    hiddenEnvironments: 2,
    workflows: [],
  };
  const labels = (collapsed: ReadonlyArray<string>) =>
    mapRows(map, new Set(collapsed)).map((row) =>
      row.kind === "more" ? `${row.depth} +${row.count}` : `${row.depth} ${row.label}`,
    );

  it("lists the tree depth-first with the root page and the collapsed counts", () => {
    expect(labels([])).toEqual([
      "0 https://shop.test",
      "1 /",
      "1 /orders",
      "2 /:id",
      "2 +3",
      "0 +2",
    ]);
  });

  it("hides what is under a collapsed row", () => {
    expect(labels(["https://shop.test\n/orders"])).toEqual([
      "0 https://shop.test",
      "1 /",
      "1 /orders",
      "0 +2",
    ]);
    expect(labels(["https://shop.test"])).toEqual(["0 https://shop.test", "0 +2"]);
  });

  it("labels coverage", () => {
    expect(mapCoverageLabel(page("/a"))).toBe("seen, not tested");
    expect(mapCoverageLabel(page("/a", { coverage: "failing", passCount: 2, failCount: 1 }))).toBe(
      "1 FAIL, 2 PASS",
    );
  });
});
