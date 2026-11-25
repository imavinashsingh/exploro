import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  SecretRef,
  SecretRequestError,
  ThreadId,
  type PreviewAutomationRequest,
  type QaReplayStep,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import {
  createPendingAttachmentId,
  parseThreadSegmentFromAttachmentId,
} from "../../../attachmentStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as QaRecorder from "../../../qa/QaRecorder.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import { layerStandard } from "./handlers.ts";
import { claimPreviewRecording } from "./recordingClaim.ts";
import { PreviewStandardToolkit } from "./tools.ts";

const loggedSteps: QaReplayStep[] = [];

it.effect("preview_open navigates the opened tab to a dev server in one tool call", () =>
  Effect.gen(function* () {
    loggedSteps.length = 0;
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const connected = yield* Deferred.make<void>();
    const tabId = PreviewTabId.make("opened-tab");
    const target = {
      kind: "environment-port" as const,
      port: 3000,
      path: "/settings?tab=account",
    };
    const requests: PreviewAutomationRequest[] = [];
    const status = {
      available: true,
      visible: false,
      tabId,
      url: "http://localhost:3000/settings?tab=account",
      title: "Settings",
      loading: false,
    };
    const events = yield* broker.connect({
      clientId: "client-1",
      environmentId: scope.environmentId,
    });
    yield* Stream.runForEach(events, (event) => {
      if (event.type === "connected") return Deferred.succeed(connected, undefined);
      requests.push(event.request);
      return broker.respond({
        clientId: "client-1",
        connectionId: event.connectionId,
        requestId: event.request.requestId,
        ok: true,
        result:
          event.request.operation === "open"
            ? { ...status, url: "about:blank" }
            : event.request.operation === "click"
              ? {
                  recordedTarget: {
                    selector: 'internal:role=button[name="Save"i]',
                    display: "getByRole('button')",
                  },
                }
              : status,
      });
    }).pipe(Effect.forkScoped);
    yield* Deferred.await(connected);
    const toolkit = yield* PreviewStandardToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(layerStandard)),
    );
    const results = yield* toolkit
      .handle("preview_open", {
        url: "http://localhost:3000",
        target,
        open: false,
        reuseExistingTab: false,
      })
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(results.at(-1)?.result).toEqual(status);
    expect(requests.map(({ operation, input }) => ({ operation, input }))).toEqual([
      { operation: "open", input: { open: false, show: false, reuseExistingTab: false } },
      { operation: "navigate", input: { target } },
    ]);
    expect(requests[1]?.tabId).toBe(tabId);
    expect(requests[1]?.tabIdExplicit).toBe(true);
    // The replay opens where the target led, not the url the target replaced.
    expect(loggedSteps).toEqual([{ kind: "navigate", url: status.url }]);

    const clicked = yield* toolkit
      .handle("preview_act", { action: "click", locator: "aria-ref=e3" })
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(JSON.stringify(clicked.at(-1)?.result)).not.toContain("recordedTarget");
    expect(loggedSteps.at(-1)).toEqual({
      kind: "click",
      target: { selector: 'internal:role=button[name="Save"i]', display: "getByRole('button')" },
    });
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment-1"),
      requestNamespace: "provider-session-1",
      thread: {
        threadId: ThreadId.make("thread-1"),
        providerSessionId: "provider-session-1",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
      capabilities: new Set(["preview"] as const),
      issuedAt: 1,
    }),
    Effect.provide(
      Layer.mergeAll(
        PreviewAutomationBroker.layer,
        liveThreadsLayer,
        Layer.mock(QaRecorder.QaRecorder)({
          browserOpened: () => Effect.void,
          stepPerformed: (_threadId, step) => Effect.sync(() => void loggedSteps.push(step)),
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
      ).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
    ),
  ),
);

const ref = SecretRef.make(`secret-ref:${"a".repeat(32)}`);
const passwordField = { selector: 'internal:label="Password"i', display: "getByLabel('Password')" };
/** A one-use secret. */
const secretRequestsLayer = () => {
  const refs = new Map<SecretRef, string>([[ref, "hunter2!"]]);
  return Layer.mock(SecretRequests.SecretRequests)({
    consume: (input) =>
      Effect.suspend(() => {
        const value = refs.get(input.ref);
        if (value === undefined)
          return Effect.fail(new SecretRequestError({ reason: "ref_unavailable" }));
        refs.delete(input.ref);
        return Effect.succeed(value);
      }),
  });
};

it.effect("preview_act types a secretRef's value unseen and consumes it once", () =>
  Effect.gen(function* () {
    loggedSteps.length = 0;
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const connected = yield* Deferred.make<void>();
    const requests: PreviewAutomationRequest[] = [];
    const events = yield* broker.connect({
      clientId: "client-1",
      environmentId: scope.environmentId,
    });
    yield* Stream.runForEach(events, (event) => {
      if (event.type === "connected") return Deferred.succeed(connected, undefined);
      requests.push(event.request);
      return broker.respond({
        clientId: "client-1",
        connectionId: event.connectionId,
        requestId: event.request.requestId,
        ok: true,
        result: { recordedTarget: passwordField },
      });
    }).pipe(Effect.forkScoped);
    yield* Deferred.await(connected);
    const toolkit = yield* PreviewStandardToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(layerStandard)),
    );
    const act = (input: Record<string, unknown>) =>
      toolkit
        .handle("preview_act", { action: "type", locator: "aria-ref=e7", ...input } as never)
        .pipe(Stream.unwrap, Stream.runCollect);

    const typed = yield* act({ secretRef: ref });
    expect(JSON.stringify(typed.at(-1)?.result)).not.toContain("hunter2!");
    const typeRequests = requests.filter((request) => request.operation === "type");
    expect(typeRequests.map(({ input }) => input)).toEqual([
      { locator: "aria-ref=e7", text: "hunter2!" },
    ]);
    // A replay must not save the password, and a one-use ref cannot be typed again.
    expect(loggedSteps.at(-1)?.kind).toBe("unreplayable");

    const reused = yield* Effect.flip(act({ secretRef: ref }));
    expect(reused.message).toContain("already used");
    const both = yield* Effect.flip(act({ secretRef: ref, text: "x" }));
    expect(both.message).toContain("Pass one of");
    expect(requests.filter((request) => request.operation === "type")).toHaveLength(1);
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment-1"),
      requestNamespace: "provider-session-1",
      thread: {
        threadId: ThreadId.make("thread-1"),
        providerSessionId: "provider-session-1",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
      capabilities: new Set(["preview"] as const),
      issuedAt: 1,
    }),
    Effect.provide(
      Layer.mergeAll(
        PreviewAutomationBroker.layer,
        liveThreadsLayer,
        Layer.mock(QaRecorder.QaRecorder)({
          stepPerformed: (_threadId, step) => Effect.sync(() => void loggedSteps.push(step)),
        }),
        secretRequestsLayer(),
      ).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
    ),
  ),
);

describe("claimPreviewRecording", () => {
  it.effect("overlapping and repeated claims return the same retained recording", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const uploadedAttachmentId = createPendingAttachmentId(".webm");
      const pendingPath = path.join(config.attachmentsDir, `${uploadedAttachmentId}.webm`);
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(pendingPath, "video!");
      const response = {
        id: "desktop-recording",
        tabId: "tab-1",
        path: "/desktop/recording.webm",
        mimeType: "video/webm",
        sizeBytes: 6,
        createdAt: "2026-09-07T00:00:00.000Z",
        uploadedAttachmentId,
      };
      const claim = claimPreviewRecording(ThreadId.make("thread-1"), response);
      const [first, second] = yield* Effect.all([claim, claim], { concurrency: "unbounded" });
      expect(first).toEqual(second);
      expect(yield* claim).toEqual(first);
      expect(yield* fileSystem.readFileString(first.path)).toBe("video!");
      expect(yield* fileSystem.exists(pendingPath)).toBe(false);
      const wrongThread = yield* claimPreviewRecording(ThreadId.make("thread-2"), response).pipe(
        Effect.result,
      );
      expect(wrongThread._tag).toBe("Failure");
      const wrongPath = yield* claimPreviewRecording(ThreadId.make("thread-1"), {
        ...response,
        uploadedAttachmentId: `../${uploadedAttachmentId}`,
      }).pipe(Effect.result);
      expect(wrongPath._tag).toBe("Failure");
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-recording-" }).pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );

  it.effect.each([6, 5])(
    "claims only a complete uploaded recording (reported bytes: %s)",
    (sizeBytes) =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const uploadedAttachmentId = createPendingAttachmentId(".webm");
        const pendingPath = path.join(config.attachmentsDir, `${uploadedAttachmentId}.webm`);
        yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
        yield* fileSystem.writeFileString(pendingPath, "video!");
        const response = {
          id: "desktop-recording",
          tabId: "tab-1",
          path: "/desktop/recording.webm",
          mimeType: "video/webm",
          sizeBytes,
          createdAt: "2026-09-07T00:00:00.000Z",
          uploadedAttachmentId,
        };
        const result = yield* claimPreviewRecording(ThreadId.make("thread-1"), response).pipe(
          Effect.result,
        );
        if (sizeBytes === 6) {
          expect(result._tag).toBe("Success");
          if (result._tag !== "Success") return;
          expect(result.success.path).not.toBe(response.path);
          expect(parseThreadSegmentFromAttachmentId(result.success.id)).toBe("thread-1");
          expect(yield* fileSystem.readFileString(result.success.path)).toBe("video!");
          expect(yield* fileSystem.exists(pendingPath)).toBe(false);
        } else {
          expect(result._tag).toBe("Failure");
          if (result._tag !== "Failure") return;
          expect(result.failure._tag).toBe("PreviewAutomationRecordingTransferError");
          expect(yield* fileSystem.exists(pendingPath)).toBe(true);
        }
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-recording-" }).pipe(
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
      ),
  );
});
