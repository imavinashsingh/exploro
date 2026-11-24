import {
  type ProjectMemoryEvidenceRef,
  type ProjectMemoryFactInput,
  type QaRun,
} from "@t3tools/contracts";

import { redactText, redactUrl } from "../qa/qaEvidence.ts";
import { memoryEnvironmentOrigin } from "./memoryEnvironment.ts";

const ID_SEGMENT =
  /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12,}|(?=[^/]*\d)[A-Za-z0-9_-]{20,})$/i;

/** The origin a fact belongs to, from a URL or an origin; null for anything else. */
export function memoryEnvironment(urlOrOrigin: string): string | null {
  return memoryEnvironmentOrigin(urlOrOrigin);
}

/** A URL's or path's route: the path without query or fragment, with ids as `:id`. */
export function memoryRoute(urlOrPath: string): string {
  const raw = urlOrPath.trim();
  let path: string;
  try {
    path = new URL(raw).pathname;
  } catch {
    path = raw.split(/[?#]/, 1)[0] ?? "";
  }
  const segments = path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => (ID_SEGMENT.test(segment) ? ":id" : segment));
  return `/${segments.join("/")}`;
}

const cut = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)}…`);

/** Memory is data the agent reads later, so it gets the same redaction as the evidence logs. */
export function redactFactInput(input: ProjectMemoryFactInput): ProjectMemoryFactInput {
  return {
    ...input,
    key: cut(redactText(input.key), 200),
    value: cut(redactText(input.value), 500),
    ...(input.detail === undefined ? {} : { detail: cut(redactText(input.detail), 2000) }),
    ...(input.pageUrl === undefined ? {} : { pageUrl: cut(redactUrl(input.pageUrl), 2048) }),
  };
}

/** A run that could not check a scenario says nothing new about it. */
export const isObservedVerdict = (value: string) => /^(PASS|FAIL)\b/u.test(value);

const scenarioName = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

export interface RunResultFact {
  readonly scenarioIndex: number;
  /** Earlier recordings of the same scenario in this run, which this one corrects. */
  readonly corrects: ReadonlyArray<number>;
  /** Null when the latest recording has nothing to remember, such as a BLOCKED verdict. */
  readonly fact: { readonly input: ProjectMemoryFactInput; readonly observedAt: string } | null;
}

/** One entry per scenario name: only its latest recording in the run counts. */
export function resultFactsFor(run: QaRun): ReadonlyArray<RunResultFact> {
  const byName = new Map<string, Array<QaRun["scenarios"][number]>>();
  for (const scenario of run.scenarios) {
    const name = scenarioName(scenario.scenario);
    byName.set(name, [...(byName.get(name) ?? []), scenario]);
  }
  return [...byName.values()].map((recordings) => {
    const scenario = recordings.at(-1)!;
    const corrects = recordings.slice(0, -1).map((earlier) => earlier.index);
    const url = scenario.pageUrl ?? run.site;
    const environment = url === null ? null : memoryEnvironment(url);
    if (
      url === null ||
      environment === null ||
      scenario.stateId === null ||
      !isObservedVerdict(scenario.verdict)
    ) {
      return { scenarioIndex: scenario.index, corrects, fact: null };
    }
    const ref = (type: ProjectMemoryEvidenceRef["type"]): ProjectMemoryEvidenceRef => ({
      threadId: run.threadId,
      runId: run.runId,
      scenarioIndex: scenario.index,
      type,
    });
    const evidence = [
      ...(scenario.screenshotPath === null ? [] : [ref("screenshot")]),
      ...(scenario.consolePath === null ? [] : [ref("console")]),
      ...(scenario.networkPath === null ? [] : [ref("network")]),
    ];
    const cause = scenario.downgradeReason ?? scenario.actual ?? scenario.note;
    return {
      scenarioIndex: scenario.index,
      corrects,
      fact: {
        observedAt: scenario.recordedAt,
        input: redactFactInput({
          stateId: scenario.stateId,
          kind: "result",
          key: scenario.scenario,
          value:
            scenario.severity === undefined
              ? scenario.verdict
              : `${scenario.verdict} ${scenario.severity}`,
          ...(cause.trim().length === 0 ? {} : { detail: cause.trim() }),
          ...(scenario.pageUrl === null ? {} : { pageUrl: scenario.pageUrl }),
          evidence,
          author: "server",
        }),
      },
    };
  });
}
