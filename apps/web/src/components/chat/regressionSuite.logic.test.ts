import type { QaSuite } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyTexts, csvFromDataSet, dataSetFromCsv, editableTexts } from "./regressionSuite.logic";

const field = { selector: 'internal:role=textbox[name="Name"i]', display: "getByRole('textbox')" };
const suite: Pick<QaSuite, "steps" | "scenarios"> = {
  steps: [
    { kind: "navigate", url: "https://shop.test/" },
    { kind: "type", target: field, text: "ann" },
    { kind: "type", target: null, text: "{{secret:1}}" },
  ],
  scenarios: [
    {
      scenario: "Greets",
      stepCount: 3,
      checks: [
        { kind: "textVisible", text: "Welcome ann" },
        { kind: "elementVisible", target: field },
      ],
    },
  ],
};

describe("regression suite texts", () => {
  it("offers typed text and checked text, never a password placeholder", () => {
    expect(editableTexts(suite).map((text) => [text.key, text.value])).toEqual([
      ["step:0:url", "https://shop.test/"],
      ["step:1:text", "ann"],
      ["check:0:0", "Welcome ann"],
    ]);
  });

  it("puts edits back in place and leaves everything else as it was", () => {
    const edited = applyTexts(
      suite,
      new Map([
        ["step:1:text", "{{param:name}}"],
        ["check:0:0", "Welcome {{param:name}}"],
      ]),
    );
    expect(edited.steps[1]).toEqual({ kind: "type", target: field, text: "{{param:name}}" });
    expect(edited.steps[2]).toEqual(suite.steps[2]);
    expect(edited.scenarios[0]?.checks).toEqual([
      { kind: "textVisible", text: "Welcome {{param:name}}" },
      { kind: "elementVisible", target: field },
    ]);
  });
});

describe("data set CSV", () => {
  it("reads a header of parameter names and one row per replay", () => {
    const dataSet = dataSetFromCsv('name,greeting\nann,"Hi, ann"\nbob\n');
    expect(dataSet).toEqual({
      columns: ["name", "greeting"],
      rows: [
        ["ann", "Hi, ann"],
        ["bob", ""],
      ],
    });
    expect(csvFromDataSet(dataSet as never)).toBe('name,greeting\nann,"Hi, ann"\nbob,');
  });

  it.each([
    ["first name\nann", '"first name" can\'t name a parameter'],
    ["a,a\n1,2", "Each column needs its own name"],
    ["a\n1,2", "Row 1 has more values"],
  ])("refuses %j", (text, error) => {
    expect(dataSetFromCsv(text)).toEqual({ error: expect.stringContaining(error) });
  });
});
