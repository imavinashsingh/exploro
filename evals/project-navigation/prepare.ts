#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off -- This executable prepares an isolated benchmark fixture.
import * as NodeUtil from "node:util";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { pilot, prepareSeed } from "./live-driver.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    model: { type: "string" },
    provider: { type: "string", default: "claudeAgent" },
    out: { type: "string" },
    "pilot-only": { type: "boolean", default: false },
  },
});
if (!values.out)
  throw new Error("Use --out <new-directory> [--pilot-only | --model <configured-model>].");
const directory = NodePath.resolve(values.out);
await NodeFSP.mkdir(directory, { recursive: false });
const result = await pilot();
await NodeFSP.writeFile(NodePath.join(directory, "pilot.json"), JSON.stringify(result, null, 2));
if (!result.supportedCases.length)
  throw new Error("No pilot cases passed; do not spend model tokens on this website.");
if (!values["pilot-only"]) {
  if (!values.model) throw new Error("Learning requires an explicitly pinned --model.");
  if (values.provider !== "claudeAgent" && values.provider !== "codex")
    throw new Error("--provider must be claudeAgent or codex.");
  await prepareSeed(directory, values.model, values.provider);
}
