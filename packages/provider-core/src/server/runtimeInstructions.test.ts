import { assert, describe, it } from "@effect/vitest";

import { buildRuntimeInstructions } from "./runtimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it("keeps runtime identity and gives QA agents no pull request linking", () => {
    for (const pullRequestLinking of [undefined, true, false]) {
      const instructions = buildRuntimeInstructions({
        harness: "Antigravity",
        model: "gemini-3.8-flash",
        ...(pullRequestLinking === undefined ? {} : { pullRequestLinking }),
      });

      assert.include(instructions, "through the Antigravity harness, as gemini-3.8-flash.");
      assert.notInclude(instructions, "<pull_request_linking>");
      assert.notInclude(instructions, "watch_pull_request");
    }
  });
});
