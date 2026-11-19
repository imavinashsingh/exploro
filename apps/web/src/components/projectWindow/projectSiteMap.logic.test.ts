import type { QaRun, QaScenario, QaVerdict } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildSiteMap, siteMapPageKey } from "./projectSiteMap.logic";

const scenario = (index: number, pageUrl: string | null, verdict: QaVerdict): QaScenario =>
  ({
    index,
    scenario: `scenario ${index}`,
    verdict,
    note: "",
    steps: [],
    pageUrl,
    pageTitle: null,
  }) as unknown as QaScenario;

const run = (
  runId: string,
  startedAt: string,
  scenarios: ReadonlyArray<QaScenario>,
  kind: QaRun["kind"] = "exploratory",
): QaRun =>
  ({ runId, threadId: "thread-1", kind, suiteId: null, startedAt, scenarios }) as unknown as QaRun;

describe("siteMapPageKey", () => {
  it.each([
    ["https://App.test/items/42?x=1#top", "app.test/items/:id"],
    ["https://app.test/items/0b5f2c1e-3d4a-4f6b-9c8d-112233445566/edit", "app.test/items/:id/edit"],
    ["https://app.test/", "app.test/"],
    ["https://app.test/login/", "app.test/login"],
  ])("%s → %s", (url, key) => {
    expect(siteMapPageKey(url)?.key).toBe(key);
  });

  it("ignores pages that are not on the web", () => {
    expect(siteMapPageKey("about:blank")).toBeNull();
    expect(siteMapPageKey("not a url")).toBeNull();
  });
});

describe("buildSiteMap", () => {
  it("joins pages in visit order and lays them out by distance from the start", () => {
    const map = buildSiteMap([
      run("r1", "2026-11-01T00:00:00Z", [
        scenario(0, "https://app.test/login", "PASS"),
        scenario(1, "https://app.test/dashboard", "PASS"),
        scenario(2, "https://app.test/items/1", "PASS"),
        scenario(3, "https://app.test/items/2", "PASS"),
        scenario(4, null, "PASS"),
      ]),
    ]);
    expect(map.nodes.map((node) => [node.path, node.column, node.row])).toEqual([
      ["/login", 0, 0],
      ["/dashboard", 1, 0],
      ["/items/:id", 2, 0],
    ]);
    expect(map.edges).toEqual([
      { from: "app.test/login", to: "app.test/dashboard" },
      { from: "app.test/dashboard", to: "app.test/items/:id" },
    ]);
  });

  it("keeps the newest run's verdict, and the worst one within a run", () => {
    const map = buildSiteMap([
      run(
        "newer",
        "2026-11-02T00:00:00Z",
        [scenario(0, "https://app.test/upload", "PASS")],
        "regression",
      ),
      run("older", "2026-11-01T00:00:00Z", [
        scenario(0, "https://app.test/upload", "FAIL"),
        scenario(1, "https://app.test/upload", "PASS"),
        scenario(2, "https://app.test/audit", "FAIL"),
        scenario(3, "https://app.test/audit", "PASS"),
      ]),
    ]);
    const byPath = Object.fromEntries(map.nodes.map((node) => [node.path, node]));
    expect(byPath["/upload"]).toMatchObject({ status: "pass", covered: true });
    expect(byPath["/audit"]).toMatchObject({ status: "fail", covered: false });
    expect(map.coveredCount).toBe(1);
  });

  it("still places pages that are only reachable through a cycle", () => {
    const map = buildSiteMap([
      run("r1", "2026-11-01T00:00:00Z", [
        scenario(0, "https://app.test/a", "PASS"),
        scenario(1, "https://app.test/b", "PASS"),
        scenario(2, "https://app.test/a", "PASS"),
      ]),
    ]);
    expect(map.nodes.map((node) => [node.path, node.column])).toEqual([
      ["/a", 0],
      ["/b", 1],
    ]);
  });
});
