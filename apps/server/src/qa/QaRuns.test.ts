// Effect's FileSystem cannot make a junction.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { QA_MAX_SCREENSHOT_BYTES } from "./qaEvidence.ts";
import * as QaFolders from "./QaFolders.ts";
import * as QaRuns from "./QaRuns.ts";

const threadId = ThreadId.make("thread-qa-1");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

const page = (overrides: Partial<QaRuns.QaPageCapture> = {}): QaRuns.QaPageCapture => ({
  url: "https://shop.test/login",
  title: "Login",
  png: PNG,
  consoleEntries: [{ level: "error", text: "Uncaught TypeError: x is undefined", timestamp: "t" }],
  networkEntries: [
    {
      url: "https://shop.test/api/login?session=abc",
      method: "POST",
      status: 500,
      failed: false,
      timestamp: "t",
    },
  ],
  actionTimeline: [],
  ...overrides,
});

/** Every thread belongs to a project at `root`; with no root, to none. */
const foldersAt = (root: string | null) => {
  const project = root === null ? null : { projectId: ProjectId.make("shop"), root };
  return Layer.succeed(
    QaFolders.QaFolders,
    QaFolders.QaFolders.of({
      forThread: () =>
        Effect.succeed(project === null ? null : { ...project, threadTitle: "Login check" }),
      forProject: () => Effect.succeed(project),
      projects: Effect.succeed(project === null ? [] : [project]),
    }),
  );
};

let randomSeed = 0;
/** One server start over `baseDir`. */
const startServer = <A, E>(
  baseDir: string,
  projectRoot: string | null,
  body: Effect.Effect<A, E, QaRuns.QaRuns | FileSystem.FileSystem | Path.Path>,
) =>
  body.pipe(
    Effect.provide(
      QaRuns.layer.pipe(
        Layer.provide(foldersAt(projectRoot)),
        Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
        Layer.provide(
          Layer.succeed(
            SecureRandom.SecureRandom,
            SecureRandom.make((size) => new Uint8Array(size).fill((randomSeed += 1))),
          ),
        ),
      ),
    ),
  );

const tempDir = (name: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.makeTempDirectoryScoped({ prefix: `exploro-qa-${name}-` }),
  );

const withQaRuns = <A, E>(
  body: Effect.Effect<A, E, QaRuns.QaRuns | FileSystem.FileSystem | Path.Path>,
) => Effect.flatMap(tempDir("runs"), (baseDir) => startServer(baseDir, null, body));

const loginPasses = { scenario: "Login", verdict: "PASS", note: "ok" } as const;
const recordAndFinish = Effect.gen(function* () {
  const qaRuns = yield* QaRuns.QaRuns;
  yield* qaRuns.appendStep(threadId, { kind: "press", key: "Enter" });
  yield* qaRuns.recordEvidence(threadId, loginPasses, page());
  return (yield* qaRuns.finishRun(threadId, { projectId: ProjectId.make("shop") }))!;
});
const listRuns = Effect.flatMap(QaRuns.QaRuns, (qaRuns) => qaRuns.list(threadId));

it.layer(NodeServices.layer)("QaRuns", (it) => {
  it.effect("writes the manifest, evidence and self-contained reports", () =>
    withQaRuns(
      Effect.gen(function* () {
        const qaRuns = yield* QaRuns.QaRuns;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const scenario = yield* qaRuns.recordEvidence(
          threadId,
          {
            scenario: "Wrong password is rejected",
            verdict: "FAIL",
            note: "Server error instead of a message",
            severity: "major",
            steps: ["Open /login", "Submit a wrong password"],
          },
          page(),
        );
        assert.strictEqual(scenario.verdict, "FAIL");
        assert.strictEqual(scenario.consoleErrorCount, 1);
        assert.strictEqual(scenario.failedRequestCount, 1);
        assert.strictEqual(
          scenario.failedRequests[0]?.url,
          "https://shop.test/api/login?session=REDACTED",
        );
        assert.deepStrictEqual(yield* fs.readFile(scenario.screenshotPath!), PNG);

        const finished = yield* qaRuns.finishRun(threadId, { projectId: ProjectId.make("shop") });
        assert.isNotNull(finished);
        const manifest = JSON.parse(yield* fs.readFileString(path.join(finished!.dir, "run.json")));
        assert.strictEqual(manifest.scenarios[0].scenario, "Wrong password is rejected");
        assert.strictEqual(manifest.projectId, "shop");
        assert.isNotNull(manifest.finishedAt);
        assert.strictEqual(
          path.basename(scenario.screenshotPath!),
          "01-wrong-password-is-rejected.png",
        );

        const html = yield* fs.readFileString(finished!.reportHtmlPath!);
        assert.include(html, "data:image/png;base64,");
        assert.include(html, "video unavailable");
        assert.notMatch(html, /(?:src|href)="(?:https?:)?\/\//);
        const markdown = yield* fs.readFileString(finished!.reportMarkdownPath!);
        assert.include(markdown, "FAIL 1");
      }),
    ),
  );

  it.effect("downgrades a verdict without a usable screenshot", () =>
    withQaRuns(
      Effect.gen(function* () {
        const qaRuns = yield* QaRuns.QaRuns;
        const missing = yield* qaRuns.recordEvidence(
          threadId,
          { scenario: "Login works", verdict: "PASS", note: "Dashboard shown" },
          page({ png: null }),
        );
        const oversized = yield* qaRuns.recordEvidence(
          threadId,
          { scenario: "Logout works", verdict: "FAIL", note: "Still signed in" },
          page({ png: new Uint8Array(QA_MAX_SCREENSHOT_BYTES + 1) }),
        );
        for (const scenario of [missing, oversized]) {
          assert.strictEqual(scenario.verdict, "INCONCLUSIVE");
          assert.isNull(scenario.screenshotPath);
        }
        assert.strictEqual(missing.requestedVerdict, "PASS");
        assert.strictEqual(oversized.requestedVerdict, "FAIL");
      }),
    ),
  );

  it.effect("continues the thread's run after a turn ends, and deletes a run with its folder", () =>
    withQaRuns(
      Effect.gen(function* () {
        const qaRuns = yield* QaRuns.QaRuns;
        const fs = yield* FileSystem.FileSystem;
        const input = { scenario: "Home loads", verdict: "PASS", note: "ok" } as const;
        yield* qaRuns.recordEvidence(threadId, input, page());
        const first = yield* qaRuns.finishRun(threadId, { projectId: null });
        yield* qaRuns.recordEvidence(threadId, { ...input, scenario: "Login" }, page());
        const runs = yield* qaRuns.list(threadId);
        assert.strictEqual(runs.length, 1);
        assert.strictEqual(runs[0]!.runId, first!.runId);
        assert.isNull(runs[0]!.finishedAt);
        assert.deepStrictEqual(
          runs[0]!.scenarios.map((scenario) => scenario.scenario),
          ["Home loads", "Login"],
        );

        yield* qaRuns.deleteRun({ threadId, runId: first!.runId });
        assert.isFalse(yield* fs.exists(first!.dir));
        assert.deepStrictEqual(yield* qaRuns.list(threadId), []);
      }),
    ),
  );

  it.effect("places each verdict after the steps taken so far, and keeps them on disk", () =>
    withQaRuns(
      Effect.gen(function* () {
        const qaRuns = yield* QaRuns.QaRuns;
        const navigate = { kind: "navigate", url: "https://shop.test/login" } as const;
        const press = { kind: "press", key: "Enter" } as const;
        const check = { kind: "textVisible", text: "Welcome" } as const;
        yield* qaRuns.appendStep(threadId, navigate);
        const first = yield* qaRuns.recordEvidence(
          threadId,
          { scenario: "Login page", verdict: "PASS", note: "ok" },
          page(),
          [check],
        );
        yield* qaRuns.appendStep(threadId, press);
        const second = yield* qaRuns.recordEvidence(
          threadId,
          { scenario: "Login", verdict: "PASS", note: "ok" },
          page(),
        );
        assert.deepStrictEqual([first.stepCount, second.stepCount], [1, 2]);
        assert.deepStrictEqual(first.checks, [check]);
        const finished = yield* qaRuns.finishRun(threadId, { projectId: null });
        assert.deepStrictEqual(yield* qaRuns.readSteps(finished!), [navigate, press]);
      }),
    ),
  );

  it.effect("keeps an agent's evidence and turn end out of a running replay", () =>
    withQaRuns(
      Effect.gen(function* () {
        const qaRuns = yield* QaRuns.QaRuns;
        const input = { scenario: "Home loads", verdict: "PASS", note: "ok" } as const;
        const replay = yield* qaRuns.startRegressionRun(threadId, {
          suiteId: "suite-1",
          site: "https://shop.test",
          dataRow: null,
        });
        const refused = yield* qaRuns.recordEvidence(threadId, input, page()).pipe(Effect.flip);
        assert.include(refused.message, "regression replay is running");
        yield* qaRuns.appendStep(threadId, { kind: "press", key: "Enter" });
        assert.isNull(yield* qaRuns.finishRun(threadId, { projectId: null }));
        const replayed = yield* qaRuns.recordReplayedScenario(threadId, input, page(), {
          checks: [],
          stepCount: 0,
        });
        assert.strictEqual(replayed.stepCount, 0);
        const finished = yield* qaRuns.finishRun(threadId, { projectId: null, kind: "regression" });
        assert.strictEqual(finished?.runId, replay.runId);
        assert.strictEqual(finished?.kind, "regression");
        assert.deepStrictEqual(yield* qaRuns.readSteps(finished!), []);
      }),
    ),
  );
  it.effect("keeps a project's run in its folder and trusts that folder over run.json", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* tempDir("data");
      const repository = yield* tempDir("project");
      const project = path.join(repository, "app");
      const outside = yield* tempDir("outside");
      yield* fs.makeDirectory(project);
      yield* fs.makeDirectory(path.join(repository, ".git"));
      const keep = path.join(outside, "keep.png");
      yield* fs.writeFile(keep, PNG);

      const run = yield* startServer(baseDir, project, recordAndFinish);
      assert.strictEqual(path.dirname(run.dir), path.join(project, "qa-runs"));
      assert.match(path.basename(run.dir), /^\d{4}-\d\d-\d\d_\d{4}_login-check$/);
      for (const file of ["run.json", "steps.jsonl", "report.html", "report.md"])
        assert.isTrue(yield* fs.exists(path.join(run.dir, file)), file);
      assert.strictEqual(
        yield* fs.readFileString(path.join(project, "qa-runs", ".gitignore")),
        "*\n",
      );

      // The agent can edit run.json: its paths must not reach outside the run's folder.
      const manifestPath = path.join(run.dir, "run.json");
      const manifest = JSON.parse(yield* fs.readFileString(manifestPath));
      manifest.dir = outside;
      manifest.scenarios[0].screenshotPath = keep;
      yield* fs.writeFileString(manifestPath, JSON.stringify(manifest));
      yield* startServer(
        baseDir,
        project,
        Effect.gen(function* () {
          const [loaded] = yield* listRuns;
          assert.strictEqual(loaded!.dir, run.dir);
          assert.strictEqual(
            loaded!.scenarios[0]!.screenshotPath,
            path.join(run.dir, "evidence", "keep.png"),
          );
          yield* (yield* QaRuns.QaRuns).deleteRun({ threadId, runId: run.runId });
        }),
      );
      assert.isFalse(yield* fs.exists(run.dir));
      assert.isTrue(yield* fs.exists(keep));
    }),
  );

  it.effect("saves outside a project whose qa-runs folder is a link leading out", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* tempDir("data");
      const project = yield* tempDir("project");
      const outside = yield* tempDir("outside");
      // A junction needs no elevation on Windows; elsewhere the type is ignored.
      NodeFS.symlinkSync(outside, path.join(project, "qa-runs"), "junction");

      const run = yield* startServer(baseDir, project, recordAndFinish);
      assert.isTrue(run.dir.startsWith(baseDir));
      assert.deepStrictEqual(yield* fs.readDirectory(outside), []);
    }),
  );

  it.effect("moves an earlier run into its project once, and keeps it when it cannot", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* tempDir("data");
      const project = yield* tempDir("project");
      const old = yield* startServer(baseDir, null, recordAndFinish);

      const [stayed] = yield* startServer(baseDir, path.join(project, "missing"), listRuns);
      assert.strictEqual(stayed!.dir, old.dir);
      assert.isTrue(yield* fs.exists(path.join(old.dir, "evidence")));

      for (let start = 0; start < 2; start++) {
        const runs = yield* startServer(baseDir, project, listRuns);
        assert.strictEqual(runs.length, 1);
        assert.strictEqual(path.dirname(runs[0]!.dir), path.join(project, "qa-runs"));
        assert.deepStrictEqual(yield* fs.readFile(runs[0]!.scenarios[0]!.screenshotPath!), PNG);
        assert.isFalse(yield* fs.exists(old.dir));
      }
    }),
  );
});
