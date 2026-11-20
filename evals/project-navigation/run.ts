#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off -- This executable coordinates isolated host drivers, not agent reasoning.
import * as NodeUtil from "node:util";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import { navigationCases, navigationOrigin, navigationSchedule } from "./cases.ts";
import {
  gradeNavigation,
  summarizeNavigation,
  validateNavigationResult,
  type NavigationDriver,
  type NavigationTrialResult,
} from "./benchmark.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    model: { type: "string" },
    out: { type: "string" },
    driver: { type: "string" },
    seed: { type: "string" },
    case: { type: "string" },
    mode: { type: "string" },
    samples: { type: "string", default: "5" },
    shuffle: { type: "string", default: "42" },
    "dry-run": { type: "boolean", default: false },
    resume: { type: "boolean", default: false },
  },
});
if (!values.out || !values.model)
  throw new Error(
    "Use --model <configured-model> --out <new-directory> [--dry-run | --driver <module> --seed <snapshot-directory>].",
  );
const out = NodePath.resolve(values.out);
await NodeFSP.mkdir(out, { recursive: true });
const requested = values.case?.split(",");
if (requested?.some((id) => !navigationCases.some((item) => item.id === id)))
  throw new Error("Unknown --case id.");
const modes = values.mode?.split(",");
const schedule = navigationSchedule(Number(values.samples), Number(values.shuffle)).filter(
  (trial) =>
    (!requested || requested.includes(trial.caseId)) && (!modes || modes.includes(trial.mode)),
);
if (schedule.length === 0) throw new Error("No trials match --case and --mode.");
// A resumed run keeps its first schedule and records the narrower one it resumed with.
await NodeFSP.writeFile(
  NodePath.join(
    out,
    values.resume ? `schedule-resume-${NodeCrypto.randomUUID()}.json` : "schedule.json",
  ),
  JSON.stringify({ model: values.model, origin: navigationOrigin, schedule }, null, 2),
  { flag: "wx" },
);
if (!values["dry-run"]) {
  if (!values.driver || !values.seed)
    throw new Error(
      "Live runs require --driver and an immutable --seed directory; no model is started without them.",
    );
  const driver = (await import(
    NodeURL.pathToFileURL(NodePath.resolve(values.driver)).href
  )) as NavigationDriver;
  if (typeof driver.pilot !== "function" || typeof driver.runTrial !== "function")
    throw new Error("Driver must export pilot and runTrial.");
  const pilot = await driver.pilot();
  const seedDirectory = NodePath.resolve(values.seed);
  const seedManifest = JSON.parse(
    await NodeFSP.readFile(NodePath.join(seedDirectory, "manifest.json"), "utf8"),
  ) as {
    model: string;
    version: string;
  };
  if (seedManifest.model !== values.model || seedManifest.version !== pilot.version)
    throw new Error("Seed model/version does not match the pilot and pinned model.");
  const digestDirectory = async (directory: string): Promise<string> => {
    const hash = NodeCrypto.createHash("sha256");
    const visit = async (relative: string) => {
      for (const entry of (await NodeFSP.readdir(NodePath.join(directory, relative))).sort()) {
        const name = NodePath.join(relative, entry);
        const stat = await NodeFSP.lstat(NodePath.join(directory, name));
        if (stat.isSymbolicLink()) throw new Error("Seed snapshots must not contain symlinks.");
        if (stat.isDirectory()) await visit(name);
        else if (stat.isFile()) {
          hash.update(name);
          hash.update("\0");
          hash.update(await NodeFSP.readFile(NodePath.join(directory, name)));
        }
      }
    };
    await visit("");
    return hash.digest("hex");
  };
  const digest = await digestDirectory(seedDirectory);
  const scheduled = new Set(schedule.map((trial) => trial.id));
  const recorded = values.resume
    ? (await NodeFSP.readFile(NodePath.join(out, "results.ndjson"), "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              trial: (typeof schedule)[number];
              result: NavigationTrialResult;
              arrived: boolean;
              seedDigest: string;
            },
        )
    : [];
  if (
    recorded.some(
      (row) =>
        row.seedDigest !== digest ||
        row.result.model !== values.model ||
        row.result.appVersion !== pilot.version,
    )
  )
    throw new Error("Recorded trials used another seed, model, or website version; start fresh.");
  const rows = recorded.filter((row) => scheduled.has(row.trial.id));
  const finished = new Set(rows.map((row) => row.trial.id));
  await NodeFSP.writeFile(
    NodePath.join(out, "summary.json"),
    JSON.stringify(summarizeNavigation(rows), null, 2),
  );
  await NodeFSP.writeFile(
    NodePath.join(out, "pilot.json"),
    JSON.stringify(
      {
        ...pilot,
        skippedCases: [
          ...new Set(
            schedule
              .filter((trial) => !pilot.supportedCases.includes(trial.caseId))
              .map((trial) => trial.caseId),
          ),
        ],
        plannedTrials: schedule.length,
        eligibleTrials: schedule.filter((trial) => pilot.supportedCases.includes(trial.caseId))
          .length,
      },
      null,
      2,
    ),
  );
  if (!schedule.some((trial) => pilot.supportedCases.includes(trial.caseId)))
    throw new Error("No requested case passed the independent pilot.");
  for (const trial of schedule.filter((trial) => pilot.supportedCases.includes(trial.caseId))) {
    if (finished.has(trial.id)) continue;
    const item = navigationCases.find((item) => item.id === trial.caseId)!;
    const directory = NodePath.join(out, "trials", trial.id);
    // A trial interrupted mid-run left no result; keep its files aside for inspection.
    await NodeFSP.rename(directory, `${directory}.interrupted-${NodeCrypto.randomUUID()}`).catch(
      () => {},
    );
    await NodeFSP.mkdir(directory, { recursive: true });
    const seedCopy = NodePath.join(directory, "seed");
    const sharedTools = NodePath.join(seedDirectory, "home", "tools");
    await NodeFSP.cp(seedDirectory, seedCopy, {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: (source) => source !== sharedTools,
    });
    // Share installed browser binaries only; every trial owns its database, profile, and workspace.
    await NodeFSP.symlink(sharedTools, NodePath.join(seedCopy, "home", "tools"), "dir");
    let result: NavigationTrialResult;
    try {
      result = await driver.runTrial({
        trial,
        task: {
          start: item.start,
          goal: item.goal,
          origin: navigationOrigin,
          clicksOnly: "clicksOnly" in item,
        },
        model: values.model,
        directory,
        seedDirectory: seedCopy,
        actionBudget: 40,
      });
      validateNavigationResult(result);
      if (result.model !== values.model || result.appVersion !== pilot.version)
        throw new Error("Model or website version changed during the comparison.");
    } catch (error) {
      // Kept beside the trial, outside the shared results, because host errors may quote page text.
      await NodeFSP.writeFile(
        NodePath.join(directory, "error.txt"),
        error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
      );
      result = {
        outcome: "infrastructure-error",
        elapsedMs: 0,
        primitiveActions: 0,
        failedActions: 0,
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        preparationTokens: null,
        preparationMs: 0,
        observation: null,
        appVersion: pilot.version,
        threadId: null,
        model: values.model,
        error: "The host driver failed; see error.txt in this trial's directory.",
      };
    }
    const row = { trial, result, arrived: gradeNavigation(item, result), seedDigest: digest };
    rows.push(row);
    await NodeFSP.appendFile(NodePath.join(out, "results.ndjson"), `${JSON.stringify(row)}\n`);
    await NodeFSP.writeFile(
      NodePath.join(out, "summary.json"),
      JSON.stringify(summarizeNavigation(rows), null, 2),
    );
  }
  if ((await digestDirectory(seedDirectory)) !== digest)
    throw new Error("The source seed snapshot changed during the comparison.");
}
