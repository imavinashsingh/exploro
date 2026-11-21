import type { NavigationCase, NavigationMode, NavigationTrial } from "./cases.ts";
import { navigationOrigin } from "./cases.ts";

export interface NavigationTrialResult {
  readonly outcome: "finished" | "blocked" | "budget-exhausted" | "infrastructure-error";
  readonly elapsedMs: number;
  readonly primitiveActions: number;
  readonly failedActions: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly preparationTokens: number | null;
  readonly preparationMs: number;
  readonly observation: {
    readonly url: string;
    readonly headings: ReadonlyArray<string>;
    readonly source: "live-browser";
  } | null;
  readonly appVersion: string;
  readonly threadId: string | null;
  readonly model: string;
  readonly error?: string;
}

export interface NavigationDriver {
  readonly pilot: () => Promise<{
    readonly version: string;
    readonly supportedCases: ReadonlyArray<string>;
  }>;
  readonly runTrial: (input: {
    readonly trial: NavigationTrial;
    readonly task: {
      readonly start: NavigationCase["start"];
      readonly goal: string;
      readonly clicksOnly: boolean;
      readonly origin: string;
    };
    readonly model: string;
    readonly directory: string;
    readonly seedDirectory: string;
    readonly actionBudget: number;
  }) => Promise<NavigationTrialResult>;
}

export function validateNavigationResult(result: NavigationTrialResult): void {
  const counts = [
    result.primitiveActions,
    result.failedActions,
    result.inputTokens,
    result.outputTokens,
    result.cachedInputTokens,
    result.preparationTokens,
  ];
  if (
    !["finished", "blocked", "budget-exhausted", "infrastructure-error"].includes(result.outcome) ||
    !Number.isFinite(result.elapsedMs) ||
    result.elapsedMs < 0 ||
    !Number.isFinite(result.preparationMs) ||
    result.preparationMs < 0 ||
    counts.some((value) => value !== null && (!Number.isSafeInteger(value) || value < 0)) ||
    result.failedActions > result.primitiveActions ||
    (result.outcome === "finished" && !result.threadId)
  )
    throw new Error("Invalid host measurements.");
}

export function gradeNavigation(item: NavigationCase, result: NavigationTrialResult): boolean {
  if (result.outcome !== "finished" || result.observation?.source !== "live-browser") return false;
  try {
    const url = new URL(result.observation.url);
    return (
      url.origin === navigationOrigin &&
      url.pathname.includes(item.path) &&
      result.observation.headings.some((heading) => heading.trim() === item.heading)
    );
  } catch {
    return false;
  }
}

export function summarizeNavigation(
  rows: ReadonlyArray<{ trial: NavigationTrial; result: NavigationTrialResult; arrived: boolean }>,
) {
  const median = (values: number[]) => {
    if (values.length === 0) return null;
    values.sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    return values.length % 2 === 0 ? (values[middle - 1]! + values[middle]!) / 2 : values[middle]!;
  };
  const groups = new Map<string, (typeof rows)[number][]>();
  for (const row of rows) {
    const key = `${row.trial.caseId}/${row.trial.mode}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups].map(([key, group]) => ({
    key,
    trials: group.length,
    correctArrivals: group.filter((row) => row.arrived).length,
    infrastructureErrors: group.filter((row) => row.result.outcome === "infrastructure-error")
      .length,
    unknownUsage: group.filter(
      (row) => row.result.inputTokens === null || row.result.outputTokens === null,
    ).length,
    medianSuccessfulMs: median(
      group.filter((row) => row.arrived).map((row) => row.result.elapsedMs),
    ),
    medianSuccessfulTokens: median(
      group
        .filter(
          (row) =>
            row.arrived && row.result.inputTokens !== null && row.result.outputTokens !== null,
        )
        .map((row) => row.result.inputTokens! + row.result.outputTokens!),
    ),
    preparationMs: group[0]?.result.preparationMs ?? null,
    preparationTokens: group[0]?.result.preparationTokens ?? null,
    medianActions: median(group.map((row) => row.result.primitiveActions)),
  }));
}

export const modeSettings = (mode: NavigationMode) => ({
  qaMemoryEnabled: mode !== "none",
});
