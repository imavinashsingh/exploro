import { describe, expect, it } from "@effect/vitest";

import {
  budgetUserMessages,
  scrubSecrets,
  synthesizeRunProposals,
  type RunFlowStep,
} from "./memoryProposals.ts";

const run = {
  runId: "run-1",
  kind: "exploratory" as const,
  remember: true,
  finishedAt: "2026-11-24T10:00:00Z",
};
const flow: ReadonlyArray<RunFlowStep> = [
  { fromName: "Login", fromPath: "/login", action: "Sign in", toName: "Dashboard", toPath: "/" },
  {
    fromName: "Dashboard",
    fromPath: "/",
    action: "Open Orders",
    toName: "Orders",
    toPath: "/orders",
  },
];

describe("scrubSecrets", () => {
  it("removes passwords, keys, tokens and auth headers but keeps prose", () => {
    const scrubbed = scrubSecrets(
      [
        "Use the password is Hunter2! for admin",
        "api_key=abc123def456 and token: t0k3n_value",
        "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXZhbHVl",
        "key sk-proj-ABCDEFGHIJKLMNOPQRSTUV and ghp_ABCDEFGHIJKLMNOPQRSTUVWX",
        "typed secret_sauce earlier",
        "The token is expired and the password is required",
      ].join("\n"),
      ["secret_sauce"],
    );
    for (const secret of [
      "Hunter2!",
      "abc123def456",
      "t0k3n_value",
      "eyJhbGci",
      "sk-proj-ABCDEFGHIJKLMNOPQRSTUV",
      "ghp_ABCDEFGHIJKLMNOPQRSTUVWX",
      "secret_sauce",
    ])
      expect(scrubbed).not.toContain(secret);
    expect(scrubbed).toContain("The token is expired and the password is required");
  });
});

describe("budgetUserMessages", () => {
  it("cuts an oversized opening request instead of dropping later short steers", () => {
    const kept = budgetUserMessages(["x".repeat(20_000), "Use the staging account", "Skip Q&A"]);
    expect(kept.slice(1)).toEqual(["Use the staging account", "Skip Q&A"]);
    expect(kept[0]!.length).toBeLessThan(8000);
    expect(kept[0]!.endsWith("…")).toBe(true);
    // A long steer no longer pushes older short steers out of the budget.
    const steered = budgetUserMessages(["Test checkout", "Always use EUR", "y".repeat(9000)]);
    expect(steered).toContain("Always use EUR");
    expect(steered[0]).toBe("Test checkout");
  });
});

describe("synthesizeRunProposals", () => {
  it("drafts a playbook from scrubbed steers and a guide from a multi-step flow", () => {
    const drafts = synthesizeRunProposals({
      run,
      environment: "https://shop.test",
      userMessages: [
        "Test the orders page",
        "Sign in as qa@shop.test, the password is Hunter2!",
        "Orders need a paid invoice first",
      ],
      flow,
    });
    expect(drafts.map((draft) => [draft.kind, draft.slug])).toEqual([
      ["playbook", "playbook"],
      ["guide", "reach-orders"],
    ]);
    const [playbook, guide] = drafts;
    expect(playbook!.body).toContain("Orders need a paid invoice first");
    expect(playbook!.body).not.toContain("Test the orders page");
    expect(playbook!.rationale).toContain("Test the orders page");
    expect(JSON.stringify(drafts)).not.toContain("Hunter2!");
    expect(guide!.routes).toEqual(["/login", "/", "/orders"]);
    expect(guide!.body).toContain("2. On **Dashboard** (/): Open Orders → **Orders** (/orders)");
  });

  it("makes nothing from regression, unremembered or unfinished runs, or one-step flows", () => {
    const input = { environment: null, userMessages: ["a", "Use EUR"], flow };
    for (const skipped of [
      { ...run, kind: "regression" as const },
      { ...run, remember: false },
      { ...run, finishedAt: null },
    ])
      expect(synthesizeRunProposals({ ...input, run: skipped })).toEqual([]);
    expect(
      synthesizeRunProposals({ run, environment: null, userMessages: ["a"], flow: flow.slice(1) }),
    ).toEqual([]);
  });
});
