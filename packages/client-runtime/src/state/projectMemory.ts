import {
  PROJECT_UNDERSTANDING_KINDS,
  type ProjectMemoryFact,
  type ProjectMemoryFactKind,
  type ProjectMemoryFactStatus,
  type ProjectMemoryStatus,
  type ProjectUnderstandingItem,
  type ProjectUnderstandingKind,
} from "@t3tools/contracts";

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

const runs = (count: number) => (count === 1 ? "1 run" : `${count} runs`);

export function memoryStatusLine(
  status: ProjectMemoryStatus | null,
  enabled: boolean,
): MemoryStatusLine {
  if (!enabled) return { tone: "off", text: "Off. Runs here are not remembered." };
  if (status === null) return { tone: "busy", text: "Loading memory…" };
  if (status.failedExtractions.length > 0)
    return {
      tone: "failed",
      text: `Could not learn from ${runs(status.failedExtractions.length)}.`,
    };
  if (status.pendingExtractions > 0)
    return { tone: "busy", text: `Learning from ${runs(status.pendingExtractions)}.` };
  return { tone: "ready", text: "Ready." };
}
