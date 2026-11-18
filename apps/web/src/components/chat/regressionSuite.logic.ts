import type { QaCheck, QaDataSet, QaReplayStep, QaSuite } from "@t3tools/contracts";
import { parseCsv } from "@t3tools/shared/csv";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";

/** One piece of text in a suite a user may edit, such as typed text or a checked phrase. */
export interface EditableText {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

const stepTexts = (
  step: QaReplayStep,
  index: number,
  resolve: MessageResolver,
): ReadonlyArray<EditableText> => {
  const step1 = index + 1;
  switch (step.kind) {
    case "navigate":
      return [
        {
          key: `step:${index}:url`,
          label: resolve(msg("Step {step}: open URL"), { step: step1 }),
          value: step.url,
        },
      ];
    case "type":
      // Passwords stay placeholders; their values never reach the client.
      return step.text.includes("{{secret:")
        ? []
        : [
            {
              key: `step:${index}:text`,
              label: resolve(msg("Step {step}: type"), { step: step1 }),
              value: step.text,
            },
          ];
    case "waitFor":
      return [
        ...(step.text === undefined
          ? []
          : [
              {
                key: `step:${index}:text`,
                label: resolve(msg("Step {step}: wait for text"), { step: step1 }),
                value: step.text,
              },
            ]),
        ...(step.urlIncludes === undefined
          ? []
          : [
              {
                key: `step:${index}:url`,
                label: resolve(msg("Step {step}: wait for URL"), { step: step1 }),
                value: step.urlIncludes,
              },
            ]),
      ];
    default:
      return [];
  }
};

const checkText = (check: QaCheck): string | null =>
  check.kind === "textVisible"
    ? check.text
    : check.kind === "urlIncludes" || check.kind === "valueEquals"
      ? check.value
      : null;

export function editableTexts(
  suite: Pick<QaSuite, "steps" | "scenarios">,
  resolve: MessageResolver = m,
): Array<EditableText> {
  return [
    ...suite.steps.flatMap((step, index) => stepTexts(step, index, resolve)),
    ...suite.scenarios.flatMap((scenario, scenarioIndex) =>
      scenario.checks.flatMap((check, checkIndex) => {
        const value = checkText(check);
        return value === null
          ? []
          : [
              {
                key: `check:${scenarioIndex}:${checkIndex}`,
                label: resolve(
                  check.kind === "textVisible"
                    ? msg("{scenario}: shows")
                    : check.kind === "urlIncludes"
                      ? msg("{scenario}: URL includes")
                      : msg("{scenario}: field value"),
                  { scenario: scenario.scenario },
                ),
                value,
              },
            ];
      }),
    ),
  ];
}

/** The suite's steps and scenarios with the edited texts in place. */
export function applyTexts(
  suite: Pick<QaSuite, "steps" | "scenarios">,
  edits: ReadonlyMap<string, string>,
): Pick<QaSuite, "steps" | "scenarios"> {
  const edited = (key: string, value: string) => edits.get(key) ?? value;
  return {
    steps: suite.steps.map((step, index): QaReplayStep => {
      switch (step.kind) {
        case "navigate":
          return { ...step, url: edited(`step:${index}:url`, step.url) };
        case "type":
          return { ...step, text: edited(`step:${index}:text`, step.text) };
        case "waitFor":
          return {
            ...step,
            ...(step.text === undefined ? {} : { text: edited(`step:${index}:text`, step.text) }),
            ...(step.urlIncludes === undefined
              ? {}
              : { urlIncludes: edited(`step:${index}:url`, step.urlIncludes) }),
          };
        default:
          return step;
      }
    }),
    scenarios: suite.scenarios.map((scenario, scenarioIndex) => ({
      ...scenario,
      checks: scenario.checks.map((check, checkIndex): QaCheck => {
        const key = `check:${scenarioIndex}:${checkIndex}`;
        switch (check.kind) {
          case "textVisible":
            return { ...check, text: edited(key, check.text) };
          case "urlIncludes":
          case "valueEquals":
            return { ...check, value: edited(key, check.value) };
          case "elementVisible":
            return check;
        }
      }),
    })),
  };
}

const csvCell = (value: string) =>
  /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

export function csvFromDataSet(dataSet: QaDataSet): string {
  if (dataSet.columns.length === 0) return "";
  return [dataSet.columns, ...dataSet.rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

/** The first row names the parameters; each later row is one replay. */
export function dataSetFromCsv(
  text: string,
  resolve: MessageResolver = m,
): QaDataSet | { readonly error: string } {
  const [header, ...rows] = parseCsv(text);
  if (header === undefined) return { columns: [], rows: [] };
  const columns = header.map((name) => name.trim());
  const bad = columns.find((name) => !/^[A-Za-z0-9_-]{1,40}$/.test(name));
  if (bad !== undefined)
    return {
      error: resolve(msg('"{name}" can\'t name a parameter. Use letters, digits, - or _.'), {
        name: bad,
      }),
    };
  if (new Set(columns).size !== columns.length)
    return { error: resolve(msg("Each column needs its own name.")) };
  const short = rows.findIndex((row) => row.length > columns.length);
  if (short !== -1)
    return {
      error: resolve(msg("Row {row} has more values than there are columns."), { row: short + 1 }),
    };
  if (rows.length > 100) return { error: resolve(msg("A data set holds at most 100 rows.")) };
  return { columns, rows: rows.map((row) => columns.map((_, index) => row[index] ?? "")) };
}
