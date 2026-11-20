import { describe, expect, it } from "@effect/vitest";
import { navigationCases, navigationSchedule } from "./cases.ts";
import {
  gradeNavigation,
  validateNavigationResult,
  modeSettings,
  summarizeNavigation,
  type NavigationTrialResult,
} from "./benchmark.ts";

const result = (overrides: Partial<NavigationTrialResult> = {}): NavigationTrialResult => ({
  outcome: "finished",
  elapsedMs: 100,
  primitiveActions: 2,
  failedActions: 0,
  inputTokens: 100,
  outputTokens: 20,
  cachedInputTokens: 50,
  preparationTokens: 30,
  preparationMs: 5,
  observation: {
    url: "https://opensource-demo.orangehrmlive.com/web/index.php/pim/viewPersonalDetails/empNumber/7",
    headings: ["Personal Details"],
    source: "live-browser",
  },
  appVersion: "5.9",
  threadId: "trial-thread",
  model: "configured-model",
  ...overrides,
});

describe("navigation benchmark", () => {
  it("grades independent live arrival rather than URL or agent completion alone", () => {
    expect(gradeNavigation(navigationCases[0], result())).toBe(true);
    expect(() => validateNavigationResult(result({ elapsedMs: NaN }))).toThrow();
    expect(() => validateNavigationResult(result({ failedActions: 3 }))).toThrow();
    expect(() => validateNavigationResult(result({ inputTokens: -1 }))).toThrow();
    expect(gradeNavigation(navigationCases[0], result({ observation: null }))).toBe(false);
    expect(
      gradeNavigation(
        navigationCases[0],
        result({
          observation: {
            url: "https://other.test/pim/viewPersonalDetails/7",
            headings: ["Personal Details"],
            source: "live-browser",
          },
        }),
      ),
    ).toBe(false);
    expect(
      gradeNavigation(
        navigationCases[0],
        result({
          observation: {
            url: result().observation!.url,
            headings: ["Login"],
            source: "live-browser",
          },
        }),
      ),
    ).toBe(false);
    expect(gradeNavigation(navigationCases[0], result({ outcome: "budget-exhausted" }))).toBe(
      false,
    );
  });

  it("includes failures and unknown usage without double counting cached tokens", () => {
    const trial = navigationSchedule(1, 42)[0]!;
    const report = summarizeNavigation([
      { trial, result: result(), arrived: true },
      {
        trial: { ...trial, repetition: 1 },
        result: result({ inputTokens: null, outcome: "blocked" }),
        arrived: false,
      },
    ])[0]!;
    expect(report).toMatchObject({
      trials: 2,
      correctArrivals: 1,
      unknownUsage: 1,
      medianSuccessfulTokens: 120,
    });
    expect(modeSettings("graph")).toEqual({ qaMemoryEnabled: false, qaNavigationMemory: true });
  });

  it("produces a reproducible balanced 195 trial screening schedule", () => {
    const rows = navigationSchedule(5, 42);
    expect(rows).toHaveLength(195);
    expect(new Set(rows.map((row) => row.id)).size).toBe(195);
    expect(navigationSchedule(5, 42)).toEqual(rows);
    expect(navigationSchedule(5, 7)).not.toEqual(rows);
    expect(() => navigationSchedule(0, 42)).toThrow();
  });
});
