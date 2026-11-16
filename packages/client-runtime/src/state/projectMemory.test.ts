import { ProjectId, type ProjectMemoryFact, type ProjectMemoryStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_FACT_FILTER,
  factFilterOptions,
  factVersions,
  filterFacts,
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
