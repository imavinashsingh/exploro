import type { QaCheck, QaReplayStep, QaRun } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { actStep, buildSuite, fillSecrets, hideSecrets, rebaseUrl, waitStep } from "./qaReplay.ts";

const save = { selector: 'internal:role=button[name="Save"i]', display: "getByRole('button')" };

describe("replay steps", () => {
  it.each([
    ["click", { locator: "aria-ref=e1" }, save, { kind: "click", target: save }],
    ["click", { x: 10, y: 20 }, null, { kind: "clickAt", x: 10, y: 20 }],
    ["type", { text: "hi" }, null, { kind: "type", target: null, text: "hi" }],
    [
      "type",
      { locator: "aria-ref=e9", text: "hi" },
      null,
      { kind: "unreplayable", action: "type", reason: "The field could not be named." },
    ],
    [
      "drag",
      { source: "aria-ref=e1", target: "aria-ref=e2" },
      null,
      { kind: "unreplayable", action: "drag", reason: "Drag and drop is not replayed yet." },
    ],
  ] as const)("%s %j becomes a replayable step or says why not", (action, input, target, step) => {
    expect(actStep(action, input, target)).toEqual(step);
  });

  it("a wait on an element it cannot name is not replayable", () => {
    expect(waitStep({}, true, null).kind).toBe("unreplayable");
    expect(waitStep({ text: "Welcome" }, false, null)).toEqual({
      kind: "waitFor",
      target: null,
      text: "Welcome",
    });
  });
});

describe("secret placeholders", () => {
  it("numbers passwords in the order the user gave them and fills them back", () => {
    // The longer secret contains the shorter one, so it must be replaced first.
    const secrets = ["pass1", "pass1-long"];
    const hidden = hideSecrets("pass1-long then pass1", secrets);
    expect(hidden).toBe("{{secret:2}} then {{secret:1}}");
    expect(fillSecrets(hidden, secrets)).toEqual({ text: "pass1-long then pass1" });
  });

  it("names a placeholder the thread no longer answers", () => {
    expect(fillSecrets("{{secret:1}} {{secret:3}}", ["a1"])).toEqual({ missing: 3 });
  });
});

describe("building a suite", () => {
  const welcome: QaCheck = { kind: "textVisible", text: "Welcome" };
  const scenario = (
    name: string,
    verdict: "PASS" | "FAIL",
    stepCount: number | null,
    checks: ReadonlyArray<QaCheck>,
  ) => ({ scenario: name, verdict, stepCount, checks }) as unknown as QaRun["scenarios"][number];
  const steps: ReadonlyArray<QaReplayStep> = [
    { kind: "navigate", url: "https://shop.test/login" },
    { kind: "click", target: save },
    { kind: "unreplayable", action: "drag", reason: "Drag and drop is not replayed yet." },
    { kind: "click", target: save },
  ];

  it("keeps passed, checked scenarios reached before an unreplayable step", () => {
    const built = buildSuite(
      {
        scenarios: [
          scenario("login", "PASS", 2, [welcome]),
          scenario("bad password", "FAIL", 2, [welcome]),
          scenario("no checks", "PASS", 2, []),
          scenario("old run", "PASS", null, [welcome]),
          scenario("after drag", "PASS", 4, [welcome]),
        ],
      },
      steps,
    );
    expect(built.scenarios.map((kept) => kept.scenario)).toEqual(["login"]);
    // Steps after the last kept scenario are not replayed.
    expect(built.steps).toEqual(steps.slice(0, 2));
    expect(built.skipped).toEqual([
      { scenario: "bad password", reason: "It was FAIL, not PASS." },
      { scenario: "no checks", reason: "It has no checks to replay." },
      { scenario: "old run", reason: "It was recorded before steps were logged." },
      {
        scenario: "after drag",
        reason:
          "It comes after a step the replay cannot repeat: Drag and drop is not replayed yet.",
      },
    ]);
  });
});

describe("base URL", () => {
  it.each([
    [
      "https://shop.test/cart?x=1#a",
      "https://staging.shop.test",
      "https://staging.shop.test/cart?x=1#a",
    ],
    ["https://shop.test/cart", "https://ci.test/app/", "https://ci.test/app/cart"],
    ["https://pay.example/checkout", "https://staging.shop.test", "https://pay.example/checkout"],
  ])("moves %s to %s", (url, baseUrl, expected) => {
    expect(rebaseUrl(url, "https://shop.test", baseUrl)).toBe(expected);
  });
});
