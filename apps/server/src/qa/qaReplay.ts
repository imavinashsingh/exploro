import type {
  PreviewAutomationAssertion,
  PreviewAutomationDurableTarget,
  QaCheck,
  QaReplayStep,
  QaRun,
  QaSavedSecretId,
  QaSuiteScenario,
  QaSuiteSkippedScenario,
} from "@t3tools/contracts";

type Target = PreviewAutomationDurableTarget;

/** What a `preview_act` call did, as a step a replay can repeat. */
export function actStep(
  action: string,
  input: Readonly<Record<string, unknown>>,
  target: Target | null,
): QaReplayStep {
  const unreplayable = (reason: string): QaReplayStep => ({ kind: "unreplayable", action, reason });
  const named = target === null ? null : target;
  const pointerOptions = {
    ...(typeof input.button === "string" && ["left", "right", "middle"].includes(input.button)
      ? { button: input.button as "left" | "right" | "middle" }
      : {}),
    ...(typeof input.clickCount === "number" ? { clickCount: input.clickCount } : {}),
  };
  switch (action) {
    case "click":
      if (named !== null) return { kind: "click", target: named, ...pointerOptions };
      return typeof input.x === "number" && typeof input.y === "number"
        ? { kind: "clickAt", x: input.x, y: input.y }
        : unreplayable("The clicked element could not be named.");
    case "type":
      if (named === null && (input.locator !== undefined || input.selector !== undefined))
        return unreplayable("The field could not be named.");
      return {
        kind: "type",
        target: named,
        text: typeof input.text === "string" ? input.text : "",
        ...(typeof input.clear === "boolean" ? { clear: input.clear } : {}),
      };
    case "hover":
      return named === null
        ? unreplayable("The hovered element could not be named.")
        : { kind: "hover", target: named };
    case "select":
      return named === null
        ? unreplayable("The list could not be named.")
        : {
            kind: "select",
            target: named,
            values: Array.isArray(input.values) ? input.values.map(String) : [],
          };
    case "press":
      return {
        kind: "press",
        key: typeof input.key === "string" ? input.key : "",
        ...(Array.isArray(input.modifiers)
          ? { modifiers: input.modifiers as ReadonlyArray<"Alt" | "Control" | "Meta" | "Shift"> }
          : {}),
      };
    case "scroll":
      if (named === null && (input.locator !== undefined || input.selector !== undefined))
        return unreplayable("The scrolled container could not be named.");
      return {
        kind: "scroll",
        target: named,
        ...(typeof input.deltaX === "number" ? { deltaX: input.deltaX } : {}),
        ...(typeof input.deltaY === "number" ? { deltaY: input.deltaY } : {}),
      };
    case "drag":
      return unreplayable("Drag and drop is not replayed yet.");
    case "upload":
      return unreplayable("File uploads are not replayed yet.");
    default:
      return unreplayable(`${action} is not replayed.`);
  }
}

/** A wait the agent relied on, kept so the replay waits for the same thing. */
export function waitStep(
  input: { readonly text?: string | undefined; readonly urlIncludes?: string | undefined },
  hadLocator: boolean,
  target: Target | null,
): QaReplayStep {
  if (hadLocator && target === null)
    return { kind: "unreplayable", action: "waitFor", reason: "The element could not be named." };
  return {
    kind: "waitFor",
    target,
    ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.urlIncludes === undefined ? {} : { urlIncludes: input.urlIncludes }),
  };
}

const PLACEHOLDER = /\{\{secret:(\d+)\}\}/g;

/** Writes each password the user gave as `{{secret:N}}`, N counting from 1 in the order given. */
export function hideSecrets(text: string, secretsInOrder: ReadonlyArray<string>): string {
  const longestFirst = secretsInOrder
    .map((secret, index) => ({ secret, index }))
    .sort((left, right) => right.secret.length - left.secret.length);
  return longestFirst.reduce(
    (hidden, { secret, index }) => hidden.split(secret).join(`{{secret:${index + 1}}}`),
    text,
  );
}

/** The text with its placeholders filled, or the first placeholder no secret answers. */
export function fillSecrets(
  text: string,
  secretsInOrder: ReadonlyArray<string>,
): { readonly text: string } | { readonly missing: number } {
  let missing: number | null = null;
  const filled = text.replace(PLACEHOLDER, (placeholder, digits: string) => {
    const secret = secretsInOrder[Number(digits) - 1];
    if (secret === undefined) missing ??= Number(digits);
    return secret ?? placeholder;
  });
  return missing === null ? { text: filled } : { missing };
}

const SAVED_PLACEHOLDER = /\{\{saved:(qa-secret-[0-9a-f]+)\}\}/g;

/** The placeholder a step types for a password remembered for the project's suites. */
export const savedSecretPlaceholder = (secretId: QaSavedSecretId) => `{{saved:${secretId}}}`;

export const savedSecretIds = (text: string): ReadonlyArray<QaSavedSecretId> => [
  ...new Set(Array.from(text.matchAll(SAVED_PLACEHOLDER), (match) => match[1] as QaSavedSecretId)),
];

export const fillSavedSecrets = (text: string, values: ReadonlyMap<string, string>) =>
  text.replace(
    SAVED_PLACEHOLDER,
    (placeholder, secretId: string) => values.get(secretId) ?? placeholder,
  );

/** The live-page assertion that re-checks a saved check. */
export function assertionFor(check: QaCheck): PreviewAutomationAssertion {
  switch (check.kind) {
    case "textVisible":
      return { kind: "textVisible", text: check.text };
    case "urlIncludes":
      return { kind: "urlIncludes", value: check.value };
    case "elementVisible":
      return { kind: "elementVisible", locator: check.target.selector };
    case "valueEquals":
      return { kind: "valueEquals", locator: check.target.selector, value: check.value };
  }
}

/** The saved form of an assertion that held, or null when its element could not be named. */
export function checkFor(
  assertion: PreviewAutomationAssertion,
  target: Target | null,
): QaCheck | null {
  switch (assertion.kind) {
    case "textVisible":
      return { kind: "textVisible", text: assertion.text };
    case "urlIncludes":
      return { kind: "urlIncludes", value: assertion.value };
    case "elementVisible":
      return target === null ? null : { kind: "elementVisible", target };
    case "valueEquals":
      return target === null ? null : { kind: "valueEquals", target, value: assertion.value };
  }
}

export function describeCheck(check: QaCheck): string {
  switch (check.kind) {
    case "textVisible":
      return `shows "${check.text}"`;
    case "urlIncludes":
      return `URL includes "${check.value}"`;
    case "elementVisible":
      return `${check.target.display} is visible`;
    case "valueEquals":
      return `${check.target.display} has value "${check.value}"`;
  }
}

export function describeStep(step: QaReplayStep): string {
  switch (step.kind) {
    case "navigate":
      return `Open ${step.url}`;
    case "click":
      return `Click ${step.target.display}`;
    case "clickAt":
      return `Click at ${Math.round(step.x)}, ${Math.round(step.y)}`;
    case "type":
      return `Type "${step.text}"${step.target === null ? "" : ` into ${step.target.display}`}`;
    case "hover":
      return `Hover ${step.target.display}`;
    case "select":
      return `Select ${step.values.join(", ")} in ${step.target.display}`;
    case "press":
      return `Press ${[...(step.modifiers ?? []), step.key].join("+")}`;
    case "scroll":
      return `Scroll${step.target === null ? "" : ` ${step.target.display}`}`;
    case "waitFor":
      return `Wait for ${[
        step.target?.display,
        step.text === undefined ? undefined : `"${step.text}"`,
        step.urlIncludes === undefined ? undefined : `URL with "${step.urlIncludes}"`,
      ]
        .filter((part) => part !== undefined)
        .join(" and ")}`;
    case "unreplayable":
      return `${step.action} (not replayable)`;
  }
}

/**
 * The scenarios of a finished run a replay can judge: passed, with checks, and reached without
 * an action the replay cannot repeat. The steps stop at the last scenario kept.
 */
export function buildSuite(
  run: Pick<QaRun, "scenarios">,
  steps: ReadonlyArray<QaReplayStep>,
): {
  readonly steps: ReadonlyArray<QaReplayStep>;
  readonly scenarios: ReadonlyArray<QaSuiteScenario>;
  readonly skipped: ReadonlyArray<QaSuiteSkippedScenario>;
} {
  const firstUnreplayable = steps.findIndex((step) => step.kind === "unreplayable");
  const blockedFrom = firstUnreplayable === -1 ? Number.POSITIVE_INFINITY : firstUnreplayable;
  const blocker = steps[firstUnreplayable];
  const scenarios: Array<QaSuiteScenario> = [];
  const skipped: Array<QaSuiteSkippedScenario> = [];
  for (const scenario of run.scenarios) {
    const skip = (reason: string) => skipped.push({ scenario: scenario.scenario, reason });
    if (scenario.verdict !== "PASS") skip(`It was ${scenario.verdict}, not PASS.`);
    else if (scenario.stepCount === null) skip("It was recorded before steps were logged.");
    else if (scenario.checks.length === 0) skip("It has no checks to replay.");
    else if (scenario.stepCount > blockedFrom)
      skip(
        `It comes after a step the replay cannot repeat: ${
          blocker?.kind === "unreplayable" ? blocker.reason : "unknown"
        }`,
      );
    else
      scenarios.push({
        scenario: scenario.scenario,
        stepCount: scenario.stepCount,
        checks: scenario.checks,
      });
  }
  const lastStep = scenarios.reduce((last, scenario) => Math.max(last, scenario.stepCount), 0);
  return { steps: steps.slice(0, lastStep), scenarios, skipped };
}

/** The URL moved from the suite's origin to `baseUrl`'s; other origins stay as they are. */
export function rebaseUrl(url: string, suiteOrigin: string | null, baseUrl: string | undefined) {
  if (baseUrl === undefined || suiteOrigin === null) return url;
  try {
    const parsed = new URL(url);
    if (parsed.origin !== suiteOrigin) return url;
    const base = new URL(baseUrl);
    const basePath = base.pathname.replace(/\/+$/, "");
    return `${base.origin}${basePath}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}

const PARAM = /\{\{param:([A-Za-z0-9_-]{1,40})\}\}/g;

type Editable = {
  readonly steps: ReadonlyArray<QaReplayStep>;
  readonly scenarios: ReadonlyArray<QaSuiteScenario>;
};

/** Every text a user may edit in a suite: they can hold `{{param:name}}`, the rest can't change. */
function mapText(suite: Editable, map: (text: string) => string): Editable {
  const steps = suite.steps.map((step): QaReplayStep => {
    switch (step.kind) {
      case "navigate":
        return { ...step, url: map(step.url) };
      case "type":
        return { ...step, text: map(step.text) };
      case "select":
        return { ...step, values: step.values.map(map) };
      case "waitFor":
        return {
          ...step,
          ...(step.text === undefined ? {} : { text: map(step.text) }),
          ...(step.urlIncludes === undefined ? {} : { urlIncludes: map(step.urlIncludes) }),
        };
      default:
        return step;
    }
  });
  const scenarios = suite.scenarios.map((scenario) => ({
    ...scenario,
    checks: scenario.checks.map((check): QaCheck => {
      switch (check.kind) {
        case "textVisible":
          return { ...check, text: map(check.text) };
        case "urlIncludes":
        case "valueEquals":
          return { ...check, value: map(check.value) };
        case "elementVisible":
          return check;
      }
    }),
  }));
  return { steps, scenarios };
}

/** Why an edit is refused, or null when it changed only the text of steps and checks. */
export function editRefusal(before: Editable, after: Editable): string | null {
  const blank = (suite: Editable) => JSON.stringify(mapText(suite, () => ""));
  return blank(before) === blank(after)
    ? null
    : "Only the text of steps and checks can change. Steps, targets and checks cannot be added, removed or reordered.";
}

export function paramNames(suite: Editable): ReadonlyArray<string> {
  const names = new Set<string>();
  mapText(suite, (text) => {
    for (const [, name] of text.matchAll(PARAM)) names.add(name!);
    return text;
  });
  return [...names];
}

/** The suite with one data row's values in place of its `{{param:name}}`, or the first one missing. */
export function applyParams(
  suite: Editable,
  values: Readonly<Record<string, string>>,
): Editable | { readonly missing: string } {
  let missing: string | null = null;
  const filled = mapText(suite, (text) =>
    text.replace(PARAM, (placeholder, name: string) => {
      const value = values[name];
      if (value === undefined) missing ??= name;
      return value ?? placeholder;
    }),
  );
  return missing === null ? filled : { missing };
}

/** The element a step acts on, which healing may replace. */
export function stepTarget(step: QaReplayStep): Target | null {
  switch (step.kind) {
    case "click":
    case "hover":
    case "select":
      return step.target;
    case "type":
    case "scroll":
    case "waitFor":
      return step.target;
    default:
      return null;
  }
}

export function withTarget(step: QaReplayStep, target: Target): QaReplayStep {
  return stepTarget(step) === null ? step : ({ ...step, target } as QaReplayStep);
}

/** Asks for the element the step meant, in the page as it is now. Its answer is only a proposal. */
export function healPrompt(step: QaReplayStep, accessibilityTree: string): string {
  return [
    "A saved browser test could not find the element for one step. The page may have changed.",
    `The step: ${describeStep(step)}`,
    `Its saved locator: ${stepTarget(step)?.selector ?? "none"}`,
    "Here is the page's accessibility tree. Each element has a [ref=...].",
    "Pick the one element the step most likely meant. If none clearly matches, answer null.",
    'Answer JSON only: {"ref": "<the ref, without brackets>"} or {"ref": null}.',
    "",
    accessibilityTree,
  ].join("\n");
}
