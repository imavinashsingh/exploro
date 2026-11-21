import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  EnvironmentId,
  PreviewTabId,
  ProjectId,
  ProviderInstanceId,
  QaRun,
  QaRunId,
  ThreadId,
  type NavigationObserveInput,
  type OrchestrationV2ThreadShell,
  type PreviewAutomationCheckResult,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import type {
  ProjectionRecordField,
  ProjectionRecords,
} from "../orchestration-v2/ProjectionStore.ts";
import * as Folders from "../project/ManagedProjectFolders.ts";
import * as Runs from "../qa/QaRuns.ts";
import * as Settings from "../serverSettings.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Capture from "./NavigationCapture.ts";
import * as Navigation from "./ProjectNavigationMemory.ts";

const projectId = ProjectId.make("capture-project");
const threadId = ThreadId.make("capture-thread");
const tabId = PreviewTabId.make("capture-tab");
const scope: McpThreadInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "test",
  thread: {
    threadId,
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    providerSessionId: "session",
  },
  client: undefined,
  capabilities: new Set(["preview", "memory"]),
  issuedAt: 0,
};
const run = QaRun.make({
  runId: QaRunId.make("run"),
  threadId,
  projectId,
  kind: "exploratory",
  suiteId: null,
  dataRow: null,
  site: "https://shop.test",
  startedAt: "2026-11-19T00:00:00Z",
  finishedAt: null,
  dir: "/test",
  scenarios: [],
  recordingStartedAt: null,
  video: null,
  videoUnavailableReason: null,
  reportMarkdownPath: null,
  reportHtmlPath: null,
});
const input: NavigationObserveInput = {
  name: "Profile",
  aliases: [],
  context: {},
  checks: [{ kind: "textVisible", text: "Profile" }],
};

it.effect("requires a live screen check and runtime access before persisting navigation", () =>
  Effect.gen(function* () {
    let url = "https://shop.test/profile";
    let matches = true;
    let scratch = false;
    let reads = 0;
    const operations = new Set<string>();
    const layer = Capture.layer.pipe(
      Layer.provideMerge(Navigation.layer),
      Layer.provide(Sqlite.layerMemory),
      Layer.provide(NodeCrypto.layer),
      Layer.provide(
        Layer.mock(Broker.PreviewAutomationBroker)({
          invoke: <A>(request: Broker.PreviewAutomationInvokeInput) =>
            Effect.sync(() => {
              reads += 1;
              operations.add(request.operation);
              request.onTargetTab?.(tabId);
              const result: PreviewAutomationCheckResult | PreviewAutomationStatus =
                request.operation === "check"
                  ? {
                      results: [
                        { ok: matches, actual: matches ? "Profile" : "Login", target: null },
                      ],
                    }
                  : { available: true, visible: false, tabId, url, title: "Page", loading: false };
              return result as A;
            }),
        }),
      ),
      Layer.provide(
        Layer.mock(Threads.ThreadManagementService)({
          getThreadShell: () => Effect.succeed({ projectId } as OrchestrationV2ThreadShell),
          getThreadRecords: <K extends ProjectionRecordField>(
            _id: ThreadId,
            fields: ReadonlyArray<K>,
          ) =>
            Effect.succeed(
              Object.fromEntries(
                fields.map((field) => [field, []]),
              ) as unknown as ProjectionRecords<K>,
            ),
        }),
      ),
      Layer.provide(
        Layer.mock(Folders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(scratch),
        }),
      ),
      Layer.provide(
        Layer.mock(Runs.QaRuns)({
          ensureRun: () => Effect.succeed(run),
          openRun: () => Effect.succeed(run),
          readSteps: () => Effect.succeed([]),
        }),
      ),
      Layer.provideMerge(Settings.layerTest({ qaMemoryEnabled: true })),
    );
    yield* Effect.gen(function* () {
      const capture = yield* Capture.NavigationCapture;
      const memory = yield* Navigation.ProjectNavigationMemory;
      const unknown = yield* Effect.result(capture.recognize(scope));
      assert.strictEqual(unknown._tag, "Failure");
      if (unknown._tag === "Failure") assert.include(unknown.failure.message, "navigation_observe");
      // Pages memory may not store still record evidence, just without a screen.
      for (const unstorable of ["https://accounts.example/login", "about:blank"]) {
        url = unstorable;
        assert.isNull(yield* capture.recognize(scope));
      }
      url = "https://shop.test/profile";
      matches = false;
      assert.strictEqual((yield* Effect.result(capture.observe(scope, input)))._tag, "Failure");
      assert.strictEqual((yield* memory.snapshot(projectId)).states.length, 0);
      matches = true;
      const state = yield* capture.observe(scope, input);
      assert.strictEqual(state.path, "/profile");
      assert.strictEqual((yield* capture.recognize(scope))?.id, state.id);
      assert.strictEqual((yield* memory.snapshot(projectId)).states.length, 1);
      const renamed = yield* capture.observe(scope, {
        ...input,
        name: "Account",
        checks: [{ kind: "textVisible", text: "Account" }],
      });
      assert.strictEqual(renamed.id, state.id);
      assert.deepStrictEqual(renamed.aliases, ["Account"]);
      assert.strictEqual(
        (yield* capture.route(scope, { destination: "Account" })).status,
        "already-there",
      );
      const duplicate = yield* memory.observe(projectId, {
        state: {
          name: "Profile copy",
          aliases: [],
          context: { role: "guest" },
          checks: [{ kind: "textVisible", text: "Profile" }],
          environment: "https://shop.test",
          path: "/profile",
        },
        threadId,
        runId: "other",
        tabId: "other-tab",
        stepIndex: 0,
      });
      assert.strictEqual(
        (yield* capture.route(scope, { fromStateId: duplicate.id, destination: "Account" })).status,
        "already-there",
      );
      matches = false;
      const unknownStart = yield* capture.route(scope, {
        fromStateId: state.id,
        destination: "Account",
      });
      assert.strictEqual(unknownStart.status, "unrecognized");
      assert.strictEqual(unknownStart.directUrl, "https://shop.test/profile");
      matches = true;
      url = "https://other.test/profile";
      assert.strictEqual((yield* Effect.result(capture.observe(scope, input)))._tag, "Failure");
      url = "about:blank";
      assert.strictEqual((yield* Effect.result(capture.observe(scope, input)))._tag, "Failure");
      url = "https://shop.test/profile";
      assert.strictEqual(
        (yield* Effect.result(
          capture.observe(scope, {
            ...input,
            checks: [{ kind: "urlIncludes", value: "/profile" }],
          }),
        ))._tag,
        "Failure",
      );
      const before = reads;
      yield* (yield* Settings.ServerSettingsService).updateSettings({ qaMemoryEnabled: false });
      assert.strictEqual((yield* Effect.result(capture.observe(scope, input)))._tag, "Failure");
      yield* (yield* Settings.ServerSettingsService).updateSettings({
        qaMemoryEnabled: true,
      });
      scratch = true;
      assert.strictEqual((yield* Effect.result(capture.observe(scope, input)))._tag, "Failure");
      assert.strictEqual(reads, before);
      assert.strictEqual((yield* memory.snapshot(projectId)).states.length, 2);
      // A snapshot would revoke the element refs the agent is about to click.
      assert.deepStrictEqual([...operations].toSorted(), ["check", "status"]);
    }).pipe(Effect.provide(layer));
  }),
);
