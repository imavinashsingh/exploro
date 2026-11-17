import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  PREVIEW_AUTOMATION_SERVER_OPERATIONS,
  ProjectId,
  ThreadId,
  type PreviewAutomationAssertion,
  type PreviewAutomationRequest,
  type QaCheck,
  type QaSuitesSnapshot,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { encode } from "fast-png";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import * as MemoryEmbedder from "../memory/MemoryEmbedder.ts";
import * as ProjectMemory from "../memory/ProjectMemory.ts";
import * as ProjectUnderstanding from "../memory/ProjectUnderstanding.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PreviewAgentActivity from "../preview/PreviewAgentActivity.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as QaRecorder from "./QaRecorder.ts";
import * as QaRuns from "./QaRuns.ts";
import * as QaSavedSecrets from "./QaSavedSecrets.ts";
import * as QaSuites from "./QaSuites.ts";

const threadId = ThreadId.make("thread-regress-1");
const otherThreadId = ThreadId.make("thread-regress-2");
const environmentId = EnvironmentId.make("environment-1");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString("base64");
const target = (name: string) => ({
  selector: `internal:role=button[name="${name}"i]`,
  display: `getByRole('button', { name: '${name}' })`,
});

/** A 4×4 capture, white or with its top row dark: a quarter of its pixels differ. */
const capturePng = (changed: boolean) => {
  const data = new Uint8Array(4 * 4 * 4).fill(255);
  if (changed) for (let pixel = 0; pixel < 4; pixel++) data.fill(0, pixel * 4, pixel * 4 + 3);
  return Buffer.from(encode({ width: 4, height: 4, data, channels: 4 })).toString("base64");
};

const capture = (url: string) => ({
  url,
  title: "Shop",
  png: new Uint8Array([1]),
  consoleEntries: [],
  networkEntries: [],
  actionTimeline: [],
});

interface Browser {
  readonly requests: Array<PreviewAutomationRequest>;
  /** Buttons whose click finds no element. */
  missing: ReadonlyArray<string>;
  /** Texts the page never shows. */
  absent: ReadonlyArray<string>;
  changedLook: boolean;
  /** The browser cannot open a tab, so a replay stops before its first step. */
  failOpen?: boolean;
  /** While set, the browser answers nothing until it completes. */
  hold?: Deferred.Deferred<void>;
}

const fakeBrowser = (browser: Browser) =>
  Effect.gen(function* () {
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const connected = yield* Deferred.make<void>();
    const events = yield* broker.connect({
      clientId: "browser-1",
      environmentId,
      supportedOperations: [...PREVIEW_AUTOMATION_SERVER_OPERATIONS],
    });
    const answer = (request: PreviewAutomationRequest): unknown => {
      const input = request.input as Record<string, unknown>;
      switch (request.operation) {
        case "open":
          return {
            available: true,
            visible: true,
            tabId: "tab-1",
            url: "about:blank",
            loading: false,
          };
        case "check":
          return {
            results: (input.assertions as ReadonlyArray<PreviewAutomationAssertion>).map(
              (assertion) =>
                assertion.kind === "textVisible" && browser.absent.includes(assertion.text)
                  ? { ok: false, actual: "The page does not show this text.", target: null }
                  : { ok: true, actual: "", target: null },
            ),
            ...(input.capture === undefined ? {} : { capture: capturePng(browser.changedLook) }),
          };
        case "waitFor":
          return String(input.locator).startsWith("aria-ref=")
            ? { recordedTarget: target("Pay now") }
            : {};
        case "snapshot":
          return {
            url: "https://staging.shop.test/cart",
            title: "Shop",
            accessibilityTree: '- button "Pay now" [ref=t3-1-e5]',
            screenshot: { mimeType: "image/png", data: PNG, width: 1, height: 1 },
            consoleEntries: [],
            networkEntries: [],
            actionTimeline: [],
          };
        default:
          return {};
      }
    };
    yield* Stream.runForEach(events, (event) =>
      Effect.gen(function* () {
        if (event.type === "connected") return yield* Deferred.succeed(connected, undefined);
        if (browser.hold !== undefined) yield* Deferred.await(browser.hold);
        browser.requests.push(event.request);
        const locator = String((event.request.input as { locator?: string }).locator);
        const broken =
          (event.request.operation === "open" && browser.failOpen === true) ||
          (event.request.operation === "click" &&
            browser.missing.some((name) => locator.includes(`"${name}"`)));
        return yield* broker.respond({
          clientId: "browser-1",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ...(broken
            ? {
                ok: false,
                error: { _tag: "PreviewAutomationTimeoutError", message: "No element matches." },
              }
            : { ok: true, result: answer(event.request) }),
        });
      }),
    ).pipe(Effect.forkScoped);
    yield* Deferred.await(connected);
  });

const layer = (options: {
  readonly parallelRuns?: number;
  readonly healRequests?: Array<string>;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "exploro-qa-suites-" });
    const qaRuns = QaRuns.layer.pipe(
      Layer.provide(
        ProjectMemory.layer.pipe(
          Layer.provide(
            ProjectUnderstanding.layer.pipe(Layer.provide(MemoryEmbedder.layerUnavailable)),
          ),
        ),
      ),
      Layer.provide(Layer.fresh(SqlitePersistence.layerMemory)),
    );
    const recorder = Layer.effect(
      QaRecorder.QaRecorder,
      Effect.gen(function* () {
        const runs = yield* QaRuns.QaRuns;
        return QaRecorder.QaRecorder.of({
          browserOpened: () => Effect.void,
          startVideo: () => Effect.void,
          stepPerformed: () => Effect.void,
          finish: (id, kind = "exploratory") =>
            runs.finishRun(id, { projectId: null, remember: false, kind }),
        });
      }),
    );
    return QaSuites.layer.pipe(
      Layer.provideMerge(QaSavedSecrets.layer.pipe(Layer.provide(ServerSecretStore.layer))),
      Layer.provideMerge(recorder),
      Layer.provideMerge(qaRuns),
      Layer.provideMerge(PreviewAutomationBroker.layer),
      Layer.provide(PreviewAgentActivity.layer),
      Layer.provide(
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(environmentId),
        }),
      ),
      Layer.provide(
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            qaRegressionParallelRuns: options.parallelRuns ?? 2,
          }),
        }),
      ),
      Layer.provide(
        Layer.mock(TextGeneration.TextGeneration)({
          generateLocatorHeal: (input) => {
            options.healRequests?.push(input.prompt);
            return Effect.succeed({ ref: "t3-1-e5" });
          },
        }),
      ),
      Layer.provide(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (id) =>
            Effect.succeed({
              threadId: id,
              modelSelection: { instanceId: "claudeAgent", model: "claude-haiku-5-5" },
            } as never),
          getThreadRecords: () =>
            Effect.succeed({ messages: [{ text: "the password is s3cret!" }] } as never),
        }),
      ),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
      Layer.provide(NodeCrypto.layer),
    );
  });

/** Records an exploratory run with these steps and passed scenarios, and saves it as a suite. */
const saveSuite = (
  thread: ThreadId,
  script: ReadonlyArray<
    | { readonly step: Parameters<QaRuns.QaRuns["Service"]["appendStep"]>[1] }
    | { readonly scenario: string; readonly checks: ReadonlyArray<QaCheck> }
  >,
) =>
  Effect.gen(function* () {
    const qaRuns = yield* QaRuns.QaRuns;
    const suites = yield* QaSuites.QaSuites;
    for (const entry of script) {
      if ("step" in entry) yield* qaRuns.appendStep(thread, entry.step);
      else
        yield* qaRuns.recordEvidence(
          thread,
          { scenario: entry.scenario, verdict: "PASS", note: "seen" },
          capture("https://shop.test/cart"),
          entry.checks,
        );
    }
    const source = yield* qaRuns.finishRun(thread, { projectId: null });
    return yield* suites.create({ threadId: thread, runId: source!.runId });
  });

const verdicts = (run: {
  readonly scenarios: ReadonlyArray<{ scenario: string; verdict: string }>;
}) => run.scenarios.map((scenario) => [scenario.scenario, scenario.verdict]);

it.layer(NodeServices.layer)("QaSuites", (it) => {
  it.effect("replays a saved run without a model and judges each scenario", () =>
    Effect.gen(function* () {
      const browser: Browser = {
        requests: [],
        missing: ["Pay"],
        absent: ["Paid"],
        changedLook: false,
      };
      yield* Effect.gen(function* () {
        const suites = yield* QaSuites.QaSuites;
        yield* fakeBrowser(browser);
        // The exploratory run an agent made: log in, add to cart, pay, see the receipt.
        const { suite, skipped } = yield* saveSuite(threadId, [
          { step: { kind: "navigate", url: "https://shop.test/login" } },
          { step: { kind: "type", target: null, text: "{{secret:1}}" } },
          { scenario: "Login", checks: [{ kind: "textVisible", text: "Welcome" }] },
          { step: { kind: "click", target: target("Add") } },
          { scenario: "Add to cart", checks: [{ kind: "textVisible", text: "Paid" }] },
          { step: { kind: "click", target: target("Pay") } },
          { scenario: "Checkout", checks: [{ kind: "textVisible", text: "Receipt" }] },
          { step: { kind: "click", target: target("Print") } },
          { scenario: "Receipt prints", checks: [{ kind: "textVisible", text: "Printed" }] },
        ]);
        assert.deepStrictEqual(skipped, []);
        assert.strictEqual(suite.scenarioCount, 4);

        const { runs } = yield* suites.run({
          suiteIds: [suite.suiteId],
          baseUrl: "https://staging.shop.test",
        });
        const run = runs[0]!;
        assert.strictEqual(run.kind, "regression");
        assert.isNotNull(run.finishedAt);
        assert.deepStrictEqual(verdicts(run), [
          ["Login", "PASS"],
          ["Add to cart", "FAIL"],
          ["Checkout", "INCONCLUSIVE"],
          ["Receipt prints", "INCONCLUSIVE"],
        ]);
        assert.include(run.scenarios[1]!.actual, "does not show this text");
        assert.include(run.scenarios[2]!.note, "Test broken: step 4");
        assert.notInclude(run.scenarios[2]!.note, "Healing");
        assert.include(run.scenarios[3]!.note, "Not run");
        assert.include(run.scenarios[0]!.steps.join("\n"), 'Type "{{secret:1}}"');
        assert.notInclude(JSON.stringify(run), "s3cret!");
      }).pipe(Effect.provide(yield* layer({})));

      const acted = browser.requests.filter((request) => request.operation !== "snapshot");
      assert.deepStrictEqual(
        acted.slice(0, 4).map(({ operation, input }) => ({ operation, input })),
        [
          { operation: "open", input: { reuseExistingTab: false, profileId: "incognito" } },
          {
            operation: "resize",
            input: { mode: "freeform", width: 1280, height: 800, tabId: "tab-1" },
          },
          {
            operation: "navigate",
            input: { url: "https://staging.shop.test/login", timeoutMs: 15_000, tabId: "tab-1" },
          },
          {
            operation: "check",
            input: { assertions: [], settle: true, timeoutMs: 5_000, tabId: "tab-1" },
          },
        ],
      );
      const typed = acted.find((request) => request.operation === "type");
      assert.strictEqual((typed?.input as { text?: string } | undefined)?.text, "s3cret!");
      // Every step that ran is followed by a settle before the next step looks for its target.
      const operations = acted.map((request) => request.operation);
      const ran = acted.flatMap((request, index) =>
        ["navigate", "type", "click"].includes(request.operation) &&
        !String((request.input as { locator?: string }).locator).includes('"Pay"')
          ? [index]
          : [],
      );
      assert.strictEqual(ran.length, 3);
      for (const index of ran) {
        assert.strictEqual(operations[index + 1], "check");
        assert.strictEqual((acted[index + 1]!.input as { settle?: boolean }).settle, true);
      }
      assert.strictEqual(operations.at(-1), "close");
    }),
  );

  it.effect("replays a password remembered for the project, and says so once it is removed", () =>
    Effect.gen(function* () {
      const browser: Browser = { requests: [], missing: [], absent: [], changedLook: false };
      yield* Effect.gen(function* () {
        const qaRuns = yield* QaRuns.QaRuns;
        const suites = yield* QaSuites.QaSuites;
        const saved = yield* QaSavedSecrets.QaSavedSecrets;
        yield* fakeBrowser(browser);
        const projectId = ProjectId.make("project-shop");
        const login = { projectId, label: "Shop password", site: "https://shop.test" };

        const secretId = yield* saved.remember({ ...login, value: "old-pass" });
        // A new value for the same sign-in replaces the old one, so its suites keep working.
        assert.strictEqual(yield* saved.remember({ ...login, value: "new-pass" }), secretId);
        assert.deepStrictEqual(yield* saved.read(projectId, secretId), Option.some("new-pass"));
        assert.isTrue(Option.isNone(yield* saved.read(ProjectId.make("project-other"), secretId)));

        yield* qaRuns.appendStep(threadId, { kind: "navigate", url: "https://shop.test/login" });
        yield* qaRuns.appendStep(threadId, {
          kind: "type",
          target: null,
          text: `{{saved:${secretId}}}`,
        });
        yield* qaRuns.recordEvidence(
          threadId,
          { scenario: "Login", verdict: "PASS", note: "seen" },
          capture("https://shop.test/home"),
          [{ kind: "textVisible", text: "Welcome" }],
        );
        const source = yield* qaRuns.finishRun(threadId, { projectId });
        const { suite } = yield* suites.create({ threadId, runId: source!.runId });

        const run = (yield* suites.run({ suiteIds: [suite.suiteId] })).runs[0]!;
        assert.deepStrictEqual(
          run.scenarios.map((scenario) => scenario.verdict),
          ["PASS"],
        );
        const typed = browser.requests.find((request) => request.operation === "type");
        assert.strictEqual((typed?.input as { text?: string } | undefined)?.text, "new-pass");
        assert.notInclude(JSON.stringify(run), "new-pass");

        yield* suites.forgetSecret(secretId);
        assert.deepStrictEqual(yield* saved.list, []);
        const failed = yield* suites.run({ suiteIds: [suite.suiteId] });
        assert.deepStrictEqual(failed.runs, []);
        assert.include(failed.batch.jobs[0]!.error, "saved password that was removed");
      }).pipe(Effect.provide(yield* layer({})));
    }),
  );

  it.effect("reports every scenario inconclusive when the browser cannot open", () =>
    Effect.gen(function* () {
      const browser: Browser = {
        requests: [],
        missing: [],
        absent: [],
        changedLook: false,
        failOpen: true,
      };
      yield* Effect.gen(function* () {
        const suites = yield* QaSuites.QaSuites;
        yield* fakeBrowser(browser);
        const { suite } = yield* saveSuite(threadId, [
          { step: { kind: "navigate", url: "https://shop.test/" } },
          { scenario: "Home", checks: [{ kind: "textVisible", text: "Welcome" }] },
          { step: { kind: "click", target: target("Add") } },
          { scenario: "Add to cart", checks: [{ kind: "textVisible", text: "Added" }] },
        ]);
        const run = (yield* suites.run({ suiteIds: [suite.suiteId] })).runs[0]!;
        assert.deepStrictEqual(verdicts(run), [
          ["Home", "INCONCLUSIVE"],
          ["Add to cart", "INCONCLUSIVE"],
        ]);
        assert.include(run.scenarios[1]!.note, "Not run: the replay stopped");
      }).pipe(Effect.provide(yield* layer({})));
    }),
  );

  it.effect(
    "keeps the first capture as the baseline and fails a later run that looks different",
    () =>
      Effect.gen(function* () {
        const browser: Browser = { requests: [], missing: [], absent: [], changedLook: false };
        yield* Effect.gen(function* () {
          const suites = yield* QaSuites.QaSuites;
          yield* fakeBrowser(browser);
          const { suite } = yield* saveSuite(threadId, [
            { step: { kind: "navigate", url: "https://shop.test/" } },
            { scenario: "Home", checks: [{ kind: "textVisible", text: "Welcome" }] },
          ]);
          yield* suites.update({
            suiteId: suite.suiteId,
            visual: { threshold: 0.1, masks: [".clock"] },
          });

          const first = (yield* suites.run({ suiteIds: [suite.suiteId] })).runs[0]!;
          assert.deepStrictEqual(verdicts(first), [["Home", "PASS"]]);
          assert.isNull(first.scenarios[0]!.visual?.diffRatio);

          browser.changedLook = true;
          const second = (yield* suites.run({ suiteIds: [suite.suiteId] })).runs[0]!;
          const scenario = second.scenarios[0]!;
          assert.deepStrictEqual(verdicts(second), [["Home", "FAIL"]]);
          assert.include(scenario.note, "FAIL (visual)");
          assert.strictEqual(scenario.visual?.diffRatio, 0.25);
          assert.isNotNull(scenario.visual?.diffPath);

          // Accepting the new look makes it the baseline, so the same page passes again.
          yield* suites.acceptBaseline({
            suiteId: suite.suiteId,
            threadId,
            runId: second.runId,
            scenarioIndex: 0,
          });
          const third = (yield* suites.run({ suiteIds: [suite.suiteId] })).runs[0]!;
          assert.deepStrictEqual(verdicts(third), [["Home", "PASS"]]);
          assert.strictEqual(third.scenarios[0]!.visual?.diffRatio, 0);
        }).pipe(Effect.provide(yield* layer({})));

        const captures = browser.requests.filter(
          (request) => request.operation === "check" && "capture" in (request.input as object),
        );
        assert.deepStrictEqual((captures[0]!.input as { capture: unknown }).capture, {
          masks: [".clock"],
        });
      }),
  );

  it.effect("replays once per data row, with each row's values in steps and checks", () =>
    Effect.gen(function* () {
      const browser: Browser = {
        requests: [],
        missing: [],
        absent: ["Welcome bob"],
        changedLook: false,
      };
      yield* Effect.gen(function* () {
        const suites = yield* QaSuites.QaSuites;
        yield* fakeBrowser(browser);
        const { suite } = yield* saveSuite(threadId, [
          { step: { kind: "type", target: null, text: "ann" } },
          { scenario: "Greets the user", checks: [{ kind: "textVisible", text: "Welcome ann" }] },
        ]);
        const saved = yield* suites.get(suite.suiteId);
        const refused = yield* suites
          .update({ suiteId: suite.suiteId, steps: [...saved.steps, ...saved.steps] })
          .pipe(Effect.flip);
        assert.include(refused.message, "Only the text of steps and checks can change");
        yield* suites.update({
          suiteId: suite.suiteId,
          steps: [{ kind: "type", target: null, text: "{{param:name}}" }],
          scenarios: [
            {
              ...saved.scenarios[0]!,
              checks: [{ kind: "textVisible", text: "Welcome {{param:name}}" }],
            },
          ],
          dataSet: { columns: ["name"], rows: [["ann"], ["bob"]] },
        });

        const { batch, runs } = yield* suites.run({ suiteIds: [suite.suiteId] });
        assert.deepStrictEqual(
          runs.map((run) => [run.dataRow?.values.name, run.scenarios[0]!.verdict]),
          [
            ["ann", "PASS"],
            ["bob", "FAIL"],
          ],
        );
        assert.deepStrictEqual(
          batch.jobs.map((job) => [job.status, job.counts]),
          [
            ["done", { pass: 1, fail: 0, inconclusive: 0 }],
            ["done", { pass: 0, fail: 1, inconclusive: 0 }],
          ],
        );
      }).pipe(Effect.provide(yield* layer({})));

      const typed = browser.requests
        .filter((request) => request.operation === "type")
        .map((request) => (request.input as { text: string }).text);
      assert.deepStrictEqual(typed, ["ann", "bob"]);
    }),
  );

  it.effect("queues replays past the parallel limit and runs them in turn", () =>
    Effect.gen(function* () {
      const browser: Browser = { requests: [], missing: [], absent: [], changedLook: false };
      yield* Effect.gen(function* () {
        const suites = yield* QaSuites.QaSuites;
        yield* fakeBrowser(browser);
        const script = [
          { step: { kind: "navigate" as const, url: "https://shop.test/" } },
          { scenario: "Home", checks: [{ kind: "textVisible" as const, text: "Welcome" }] },
        ];
        const first = yield* saveSuite(threadId, script);
        const second = yield* saveSuite(otherThreadId, script);

        browser.hold = yield* Deferred.make<void>();
        const { batchId } = yield* suites.start({
          suiteIds: [first.suite.suiteId, second.suite.suiteId],
          label: "All in project",
        });
        const statuses = (snapshot: QaSuitesSnapshot) =>
          snapshot.batches
            .find((entry) => entry.batchId === batchId)
            ?.jobs.map((job) => job.status) ?? [];
        const waitFor = (wanted: ReadonlyArray<string>) =>
          suites.subscribe.pipe(
            Stream.filter((snapshot) => statuses(snapshot).join() === wanted.join()),
            Stream.runHead,
          );
        // The first replay holds the only slot, so the second waits in the queue.
        yield* waitFor(["running", "queued"]);
        yield* Deferred.succeed(browser.hold, undefined);
        yield* waitFor(["done", "done"]);
        const opens = browser.requests.filter((request) => request.operation === "open");
        assert.strictEqual(opens.length, 2);
      }).pipe(Effect.provide(yield* layer({ parallelRuns: 1 })));
    }),
  );

  it.effect("turns a missing element into a fix the user accepts, then reruns with no AI", () =>
    Effect.gen(function* () {
      const healRequests: Array<string> = [];
      const browser: Browser = { requests: [], missing: ["Pay"], absent: [], changedLook: false };
      yield* Effect.gen(function* () {
        const suites = yield* QaSuites.QaSuites;
        yield* fakeBrowser(browser);
        const { suite } = yield* saveSuite(threadId, [
          { step: { kind: "click", target: target("Pay") } },
          { scenario: "Checkout", checks: [{ kind: "textVisible", text: "Receipt" }] },
        ]);

        // Off by default: the step is only reported as broken.
        const plain = (yield* suites.run({ suiteIds: [suite.suiteId] })).runs[0]!;
        assert.notInclude(plain.scenarios[0]!.note, "Healing");
        assert.strictEqual(healRequests.length, 0);

        yield* suites.update({
          suiteId: suite.suiteId,
          healing: { enabled: true, modelSelection: null },
        });
        const healed = (yield* suites.run({ suiteIds: [suite.suiteId] })).runs[0]!;
        assert.deepStrictEqual(verdicts(healed), [["Checkout", "INCONCLUSIVE"]]);
        assert.include(
          healed.scenarios[0]!.note,
          "Healing proposes getByRole('button', { name: 'Pay now' })",
        );
        assert.include(healRequests[0], "Click getByRole('button', { name: 'Pay' })");
        const proposed = yield* suites.get(suite.suiteId);
        assert.deepStrictEqual(
          proposed.proposals.map((proposal) => proposal.after),
          [target("Pay now")],
        );
        // Nothing changes until the user decides.
        assert.deepStrictEqual(proposed.steps, [{ kind: "click", target: target("Pay") }]);

        const { batchId } = yield* suites.resolveProposal({
          suiteId: suite.suiteId,
          stepIndex: 0,
          accept: true,
        });
        assert.isNotNull(batchId);
        const fixed = yield* suites.get(suite.suiteId);
        assert.deepStrictEqual(fixed.steps, [{ kind: "click", target: target("Pay now") }]);
        assert.deepStrictEqual(fixed.proposals, []);
        const rerun = yield* suites.run({ suiteIds: [suite.suiteId], heal: false });
        assert.deepStrictEqual(verdicts(rerun.runs[0]!), [["Checkout", "PASS"]]);
        assert.strictEqual(healRequests.length, 1);
      }).pipe(Effect.provide(yield* layer({ healRequests })));
    }),
  );
});
