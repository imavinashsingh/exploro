import {
  PROJECT_UNDERSTANDING_KINDS,
  type ProjectMemoryFact,
  type ProjectMemoryFactKind,
  type ProjectMemoryFactStatus,
  type ProjectMemoryMap,
  type ProjectMemoryMapBranch,
  type ProjectMemoryMapPage,
  type ProjectMemoryStatus,
  type ProjectUnderstandingItem,
  type ProjectUnderstandingKind,
} from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

export interface FactFilter {
  readonly environment: string | null;
  readonly route: string | null;
  readonly kind: ProjectMemoryFactKind | null;
  readonly status: ProjectMemoryFactStatus | null;
}

export const EMPTY_FACT_FILTER: FactFilter = {
  environment: null,
  route: null,
  kind: null,
  status: "current",
};

const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

/** The values each filter can take; routes narrow to the chosen environment. */
export function factFilterOptions(facts: ReadonlyArray<ProjectMemoryFact>, filter: FactFilter) {
  return {
    environments: sorted(facts.map((fact) => fact.environment)),
    routes: sorted(
      facts
        .filter((fact) => filter.environment === null || fact.environment === filter.environment)
        .map((fact) => fact.route),
    ),
    kinds: sorted(facts.map((fact) => fact.kind)) as ProjectMemoryFactKind[],
  };
}

export function filterFacts(
  facts: ReadonlyArray<ProjectMemoryFact>,
  filter: FactFilter,
): ReadonlyArray<ProjectMemoryFact> {
  return facts.filter(
    (fact) =>
      (filter.environment === null || fact.environment === filter.environment) &&
      (filter.route === null || fact.route === filter.route) &&
      (filter.kind === null || fact.kind === filter.kind) &&
      (filter.status === null || fact.status === filter.status),
  );
}

const identity = (fact: ProjectMemoryFact) =>
  JSON.stringify([fact.environment, fact.route, fact.kind, fact.key]);

/** Every version of the fact's page, kind and key, newest first, including the fact itself. */
export function factVersions(
  facts: ReadonlyArray<ProjectMemoryFact>,
  fact: ProjectMemoryFact,
): ReadonlyArray<ProjectMemoryFact> {
  const key = identity(fact);
  return facts
    .filter((candidate) => identity(candidate) === key)
    .sort((left, right) => right.observedAt.localeCompare(left.observedAt));
}

export type UnderstandingBadge = "confirmed" | "verified" | "hypothesis" | "needs review";

export function understandingBadge(item: ProjectUnderstandingItem): UnderstandingBadge {
  if (item.status !== "confirmed" && item.needsReview) return "needs review";
  return item.status;
}

export function understandingByKind(items: ReadonlyArray<ProjectUnderstandingItem>): ReadonlyArray<{
  readonly kind: ProjectUnderstandingKind;
  readonly items: ReadonlyArray<ProjectUnderstandingItem>;
}> {
  return PROJECT_UNDERSTANDING_KINDS.map((kind) => ({
    kind,
    items: items.filter((item) => item.kind === kind),
  })).filter((group) => group.items.length > 0);
}

export interface MemoryStatusLine {
  readonly tone: "ready" | "busy" | "failed" | "off";
  readonly text: string;
}

export function memoryStatusLine(
  status: ProjectMemoryStatus | null,
  enabled: boolean,
  resolve: MFunctionType = mFallback,
): MemoryStatusLine {
  if (!enabled) return { tone: "off", text: resolve(msg("Off. Runs here are not remembered.")) };
  if (status === null) return { tone: "busy", text: resolve(msg("Loading memory…")) };
  if (status.failedExtractions.length > 0)
    return {
      tone: "failed",
      text: resolve(
        msg(
          "{count, plural, =1 {Could not learn from 1 run.} other {Could not learn from {count} runs.}}",
        ),
        { count: status.failedExtractions.length },
      ),
    };
  if (status.pendingExtractions > 0)
    return {
      tone: "busy",
      text: resolve(
        msg("{count, plural, =1 {Learning from 1 run.} other {Learning from {count} runs.}}"),
        { count: status.pendingExtractions },
      ),
    };
  return { tone: "ready", text: resolve(msg("Ready.")) };
}

export type MapRow =
  | {
      readonly kind: "node";
      /** Stable across refreshes: the environment plus the route. */
      readonly key: string;
      readonly depth: number;
      readonly label: string;
      readonly page: ProjectMemoryMapPage | null;
      readonly expandable: boolean;
      readonly open: boolean;
    }
  | { readonly kind: "more"; readonly key: string; readonly depth: number; readonly count: number };

/** The map as the visible rows of a tree, skipping what is under a collapsed row. */
export function mapRows(
  map: ProjectMemoryMap,
  collapsed: ReadonlySet<string>,
): ReadonlyArray<MapRow> {
  const rows: Array<MapRow> = [];
  const more = (parent: string, depth: number, count: number) => {
    if (count > 0) rows.push({ kind: "more", key: `${parent}\n+`, depth, count });
  };
  const visit = (environment: string, branch: ProjectMemoryMapBranch, depth: number) => {
    const key = `${environment}\n${branch.route}`;
    const open = !collapsed.has(key);
    rows.push({
      kind: "node",
      key,
      depth,
      label: branch.route === "/" ? "/" : `/${branch.name}`,
      page: branch.page,
      expandable: branch.children.length > 0,
      open,
    });
    if (!open) return;
    branch.children.forEach((child) => visit(environment, child, depth + 1));
    more(key, depth + 1, branch.hiddenChildren);
  };
  for (const { environment, tree } of map.environments) {
    const open = !collapsed.has(environment);
    rows.push({
      kind: "node",
      key: environment,
      depth: 0,
      label: environment,
      page: null,
      expandable: true,
      open,
    });
    if (!open) continue;
    // The root is a row only when "/" itself is a page; its children hang off the environment.
    if (tree.page !== null) {
      rows.push({
        kind: "node",
        key: `${environment}\n/`,
        depth: 1,
        label: "/",
        page: tree.page,
        expandable: false,
        open: true,
      });
    }
    tree.children.forEach((child) => visit(environment, child, 1));
    more(environment, 1, tree.hiddenChildren);
  }
  more("", 0, map.hiddenEnvironments);
  return rows;
}

export function mapCoverageLabel(
  page: ProjectMemoryMapPage,
  resolve: MFunctionType = mFallback,
): string {
  if (page.coverage === "seen") return resolve(msg("seen, not tested"));
  return [
    page.failCount > 0 ? `${page.failCount} FAIL` : null,
    page.passCount > 0 ? `${page.passCount} PASS` : null,
  ]
    .filter((part) => part !== null)
    .join(", ");
}
