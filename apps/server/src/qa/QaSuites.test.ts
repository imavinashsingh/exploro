import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  PREVIEW_AUTOMATION_SERVER_OPERATIONS,
  ProjectId,
  ThreadId,
  type PreviewAutomationAssertion,
  type PreviewAutomationRequest,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

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
import * as QaRecorder from "./QaRecorder.ts";
import * as QaRuns from "./QaRuns.ts";
import * as QaSavedSecrets from "./QaSavedSecrets.ts";
import * as QaSuites from "./QaSuites.ts";

const threadId = ThreadId.make("thread-regress-1");
const environmentId = EnvironmentId.make("environment-1");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString("base64");
const target = (name: string) => ({
  selector: `internal:role=button[name="${name}"i]`,
  display: `getByRole('button', { name: '${name}' })`,
});

const capture = (url: string) => ({
  url,
  title: "Shop",
  png: new Uint8Array([1]),
  consoleEntries: [],
  networkEntries: [],
  actionTimeline: [],
});

/** Answers the replay like a browser where "Pay" is gone and "Paid" never shows. */
const fakeBrowser = (requests: Array<PreviewAutomationRequest>) =>
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
                assertion.kind === "textVisible" && assertion.text === "Paid"
                  ? { ok: false, actual: "The page does not show this text.", target: null }
                  : { ok: true, actual: "", target: null },
            ),
          };
        case "snapshot":
          return {
            url: "https://staging.shop.test/cart",
            title: "Shop",
            screenshot: { mimeType: "image/png", data: PNG, width: 1, height: 1 },
            consoleEntries: [],
            networkEntries: [],
            actionTimeline: [],
          };
        default:
          return {};
      }
    };
    yield* Stream.runForEach(events, (event) => {
      if (event.type === "connected") return Deferred.succeed(connected, undefined);
      requests.push(event.request);
      const broken =
        event.request.operation === "click" &&
        String((event.request.input as { locator?: string }).locator).includes("Pay");
      return broker.respond({
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
    }).pipe(Effect.forkScoped);
    yield* Deferred.await(connected);
  });

const layer = Effect.gen(function* () {
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
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: () => Effect.succeed({ threadId } as never),
        getThreadRecords: () =>
          Effect.succeed({ messages: [{ text: "the password is s3cret!" }] } as never),
      }),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
    Layer.provide(NodeCrypto.layer),
  );
});

it.layer(NodeServices.layer)("QaSuites", (it) => {
  it.effect("replays a saved run without a model and judges each scenario", () =>
    Effect.gen(function* () {
      const requests: Array<PreviewAutomationRequest> = [];
      yield* Effect.gen(function* () {
        const qaRuns = yield* QaRuns.QaRuns;
        const suites = yield* QaSuites.QaSuites;
        yield* fakeBrowser(requests);

        // The exploratory run an agent made: log in, add to cart, pay, see the receipt.
        const pass = (scenario: string, text: string) =>
          qaRuns.recordEvidence(
            threadId,
            { scenario, verdict: "PASS", note: "seen" },
            capture("https://shop.test/cart"),
            [{ kind: "textVisible", text }],
          );
        yield* qaRuns.appendStep(threadId, { kind: "navigate", url: "https://shop.test/login" });
        yield* qaRuns.appendStep(threadId, { kind: "type", target: null, text: "{{secret:1}}" });
        yield* pass("Login", "Welcome");
        yield* qaRuns.appendStep(threadId, { kind: "click", target: target("Add") });
        yield* pass("Add to cart", "Paid");
        yield* qaRuns.appendStep(threadId, { kind: "click", target: target("Pay") });
        yield* pass("Checkout", "Receipt");
        yield* qaRuns.appendStep(threadId, { kind: "click", target: target("Print") });
        yield* pass("Receipt prints", "Printed");
        const source = yield* qaRuns.finishRun(threadId, { projectId: null });

        const { suite, skipped } = yield* suites.create({ threadId, runId: source!.runId });
        assert.deepStrictEqual(skipped, []);
        assert.strictEqual(suite.scenarioCount, 4);

        const run = yield* suites.run({
          suiteId: suite.suiteId,
          baseUrl: "https://staging.shop.test",
        });
        assert.strictEqual(run.kind, "regression");
        assert.isNotNull(run.finishedAt);
        assert.deepStrictEqual(
          run.scenarios.map((scenario) => [scenario.scenario, scenario.verdict]),
          [
            ["Login", "PASS"],
            ["Add to cart", "FAIL"],
            ["Checkout", "INCONCLUSIVE"],
            ["Receipt prints", "INCONCLUSIVE"],
          ],
        );
        assert.include(run.scenarios[1]!.actual, "does not show this text");
        assert.include(run.scenarios[2]!.note, "Test broken: step 4");
        assert.include(run.scenarios[3]!.note, "Not run");
        assert.include(run.scenarios[0]!.steps.join("\n"), 'Type "{{secret:1}}"');
        assert.notInclude(JSON.stringify(run), "s3cret!");
      }).pipe(Effect.provide(yield* layer));

      const acted = requests.filter((request) => request.operation !== "snapshot");
      assert.deepStrictEqual(
        acted.slice(0, 3).map(({ operation, input }) => ({ operation, input })),
        [
          {
            operation: "open",
            input: { reuseExistingTab: false, profileId: "incognito" },
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
        !String((request.input as { locator?: string }).locator).includes("Pay")
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
      const requests: Array<PreviewAutomationRequest> = [];
      yield* Effect.gen(function* () {
        const qaRuns = yield* QaRuns.QaRuns;
        const suites = yield* QaSuites.QaSuites;
        const saved = yield* QaSavedSecrets.QaSavedSecrets;
        yield* fakeBrowser(requests);
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

        const run = yield* suites.run({ suiteId: suite.suiteId });
        assert.deepStrictEqual(
          run.scenarios.map((scenario) => scenario.verdict),
          ["PASS"],
        );
        const typed = requests.find((request) => request.operation === "type");
        assert.strictEqual((typed?.input as { text?: string } | undefined)?.text, "new-pass");
        assert.notInclude(JSON.stringify(run), "new-pass");

        yield* suites.forgetSecret(secretId);
        assert.deepStrictEqual(yield* saved.list, []);
        const failed = yield* Effect.flip(suites.run({ suiteId: suite.suiteId }));
        assert.include(failed.message, "saved password that was removed");
      }).pipe(Effect.provide(yield* layer));
    }),
  );
});
