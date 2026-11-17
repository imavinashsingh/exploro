import type { QaCheck, QaDataSet, QaReplayStep, QaSuite } from "@t3tools/contracts";
import { parseCsv } from "@t3tools/shared/csv";

/** One piece of text in a suite a user may edit, such as typed text or a checked phrase. */
export interface EditableText {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

const stepTexts = (step: QaReplayStep, index: number): ReadonlyArray<EditableText> => {
  const at = `Step ${index + 1}`;
  switch (step.kind) {
    case "navigate":
      return [{ key: `step:${index}:url`, label: `${at}: open URL`, value: step.url }];
    case "type":
      // Passwords stay placeholders; their values never reach the client.
      return step.text.includes("{{secret:")
        ? []
        : [{ key: `step:${index}:text`, label: `${at}: type`, value: step.text }];
    case "waitFor":
      return [
        ...(step.text === undefined
          ? []
          : [{ key: `step:${index}:text`, label: `${at}: wait for text`, value: step.text }]),
        ...(step.urlIncludes === undefined
          ? []
          : [{ key: `step:${index}:url`, label: `${at}: wait for URL`, value: step.urlIncludes }]),
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

export function editableTexts(suite: Pick<QaSuite, "steps" | "scenarios">): Array<EditableText> {
  return [
    ...suite.steps.flatMap(stepTexts),
    ...suite.scenarios.flatMap((scenario, scenarioIndex) =>
      scenario.checks.flatMap((check, checkIndex) => {
        const value = checkText(check);
        return value === null
          ? []
          : [
              {
                key: `check:${scenarioIndex}:${checkIndex}`,
                label: `${scenario.scenario}: ${check.kind === "textVisible" ? "shows" : check.kind === "urlIncludes" ? "URL includes" : "field value"}`,
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
export function dataSetFromCsv(text: string): QaDataSet | { readonly error: string } {
  const [header, ...rows] = parseCsv(text);
  if (header === undefined) return { columns: [], rows: [] };
  const columns = header.map((name) => name.trim());
  const bad = columns.find((name) => !/^[A-Za-z0-9_-]{1,40}$/.test(name));
  if (bad !== undefined)
    return { error: `"${bad}" can't name a parameter. Use letters, digits, - or _.` };
  if (new Set(columns).size !== columns.length) return { error: "Each column needs its own name." };
  const short = rows.findIndex((row) => row.length > columns.length);
  if (short !== -1) return { error: `Row ${short + 1} has more values than there are columns.` };
  if (rows.length > 100) return { error: "A data set holds at most 100 rows." };
  return { columns, rows: rows.map((row) => columns.map((_, index) => row[index] ?? "")) };
}
