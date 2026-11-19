import type { QaRun, QaVerdict, ThreadId } from "@t3tools/contracts";

export type SiteMapStatus = "pass" | "fail" | "unclear";

export interface SiteMapNode {
  readonly key: string;
  readonly path: string;
  readonly host: string;
  readonly title: string | null;
  readonly status: SiteMapStatus;
  /** A regression replay reached this page, so a suite guards it. */
  readonly covered: boolean;
  readonly last: {
    readonly threadId: ThreadId;
    readonly runId: string;
    readonly suiteId: string | null;
    readonly scenario: string;
  };
  readonly column: number;
  readonly row: number;
}

export interface SiteMapEdge {
  readonly from: string;
  readonly to: string;
}

export interface SiteMap {
  readonly nodes: ReadonlyArray<SiteMapNode>;
  readonly edges: ReadonlyArray<SiteMapEdge>;
  readonly coveredCount: number;
}

const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{16,})$/i;

/** One node per page shape: ids in the path collapse, so /items/1 and /items/2 are one page. */
export function siteMapPageKey(url: string): { key: string; host: string; path: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const segments = parsed.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => (ID_SEGMENT.test(segment) ? ":id" : segment));
  const path = `/${segments.join("/")}`;
  const host = parsed.host.toLowerCase();
  return { key: `${host}${path}`, host, path };
}

const VERDICT_STATUS: Record<QaVerdict, SiteMapStatus> = {
  PASS: "pass",
  FAIL: "fail",
  BLOCKED: "unclear",
  INCONCLUSIVE: "unclear",
  SKIPPED: "unclear",
};
const STATUS_RANK: Record<SiteMapStatus, number> = { pass: 0, unclear: 1, fail: 2 };

interface Draft {
  key: string;
  host: string;
  path: string;
  title: string | null;
  status: SiteMapStatus;
  statusRunId: string;
  covered: boolean;
  last: SiteMapNode["last"];
  order: number;
}

/** Pages the runs visited, joined in the order each run reached them; newest verdict wins. */
export function buildSiteMap(runs: ReadonlyArray<QaRun>): SiteMap {
  const drafts = new Map<string, Draft>();
  const edges = new Map<string, SiteMapEdge>();
  const oldestFirst = runs.toSorted((a, b) => a.startedAt.localeCompare(b.startedAt));
  for (const run of oldestFirst) {
    let previous: string | null = null;
    for (const scenario of run.scenarios.toSorted((a, b) => a.index - b.index)) {
      const page = scenario.pageUrl === null ? null : siteMapPageKey(scenario.pageUrl);
      if (page === null) continue;
      const status = VERDICT_STATUS[scenario.verdict];
      const last = {
        threadId: run.threadId,
        runId: run.runId,
        suiteId: run.suiteId,
        scenario: scenario.scenario,
      };
      const draft = drafts.get(page.key);
      if (draft === undefined) {
        drafts.set(page.key, {
          ...page,
          title: scenario.pageTitle,
          status,
          statusRunId: run.runId,
          covered: run.kind === "regression",
          last,
          order: drafts.size,
        });
      } else {
        // A newer run replaces the verdict; within one run the worst scenario on the page holds.
        if (draft.statusRunId !== run.runId || STATUS_RANK[status] >= STATUS_RANK[draft.status]) {
          draft.status = status;
          draft.statusRunId = run.runId;
          draft.last = last;
        }
        draft.title = scenario.pageTitle ?? draft.title;
        draft.covered ||= run.kind === "regression";
      }
      if (previous !== null && previous !== page.key) {
        edges.set(`${previous}\n${page.key}`, { from: previous, to: page.key });
      }
      previous = page.key;
    }
  }

  const ordered = [...drafts.values()].toSorted((a, b) => a.order - b.order);
  const outgoing = new Map<string, string[]>();
  const incoming = new Set<string>();
  for (const edge of edges.values()) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
    incoming.add(edge.to);
  }
  const column = new Map<string, number>();
  const walk = (start: string) => {
    if (column.has(start)) return;
    column.set(start, 0);
    const queue = [start];
    for (let head = 0; head < queue.length; head++) {
      const key = queue[head]!;
      for (const next of outgoing.get(key) ?? []) {
        if (column.has(next)) continue;
        column.set(next, column.get(key)! + 1);
        queue.push(next);
      }
    }
  };
  for (const draft of ordered) if (!incoming.has(draft.key)) walk(draft.key);
  // Pages reached only through a cycle start their own column 0.
  for (const draft of ordered) walk(draft.key);

  const rowsUsed = new Map<number, number>();
  const nodes = ordered.map((draft): SiteMapNode => {
    const col = column.get(draft.key)!;
    const row = rowsUsed.get(col) ?? 0;
    rowsUsed.set(col, row + 1);
    return {
      key: draft.key,
      path: draft.path,
      host: draft.host,
      title: draft.title,
      status: draft.status,
      covered: draft.covered,
      last: draft.last,
      column: col,
      row,
    };
  });
  return {
    nodes,
    edges: [...edges.values()],
    coveredCount: nodes.filter((node) => node.covered).length,
  };
}
