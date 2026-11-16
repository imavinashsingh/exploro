import {
  qaSiteOrigin,
  type ProjectMemoryEvidenceRef,
  type ProjectMemoryFactInput,
  type QaRun,
} from "@t3tools/contracts";

import { redactText, redactUrl } from "../qa/qaEvidence.ts";

const ID_SEGMENT =
  /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12,}|(?=[^/]*\d)[A-Za-z0-9_-]{20,})$/i;

/** The origin a fact belongs to, from a URL or an origin; null for anything else. */
export function memoryEnvironment(urlOrOrigin: string): string | null {
  return qaSiteOrigin(urlOrOrigin.trim());
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

export interface RunResultFact {
  readonly input: ProjectMemoryFactInput;
  readonly observedAt: string;
}

/** One `result` fact per scenario that has a page on an http(s) site. */
export function resultFactsFor(run: QaRun): ReadonlyArray<RunResultFact> {
  return run.scenarios.flatMap((scenario) => {
    const url = scenario.pageUrl ?? run.site;
    const environment = url === null ? null : memoryEnvironment(url);
    if (url === null || environment === null) return [];
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
    return [
      {
        observedAt: scenario.recordedAt,
        input: redactFactInput({
          environment,
          route: memoryRoute(url),
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
    ];
  });
}
