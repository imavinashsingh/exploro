import {
  PREVIEW_RECORDING_STOP_TIMEOUT_MS,
  type PreviewAutomationRecordingStatus,
  type PreviewAutomationStatus,
  type PreviewTabId,
  type QaReplayStep,
  type QaRun,
  type QaRunError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";

import * as ServerConfig from "../config.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import { claimPreviewRecording } from "../mcp/toolkits/preview/recordingClaim.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as PreviewAgentActivity from "../preview/PreviewAgentActivity.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import { threadProvidedSecretsInOrder } from "./providedSecrets.ts";
import { hideSecrets } from "./qaReplay.ts";
import * as QaRuns from "./QaRuns.ts";

const errorReason = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "message" in error &&
  typeof error.message === "string"
    ? error.message
    : "The browser could not record.";

/**
 * Records the whole run without the agent asking: the first browser open starts the video, and
 * the end of the turn (or `qa_report_finish`) stops it and writes the reports.
 */
export class QaRecorder extends Context.Service<
  QaRecorder,
  {
    readonly browserOpened: (
      scope: McpInvocationContext.McpThreadInvocationScope,
      opened: PreviewAutomationStatus,
    ) => Effect.Effect<void>;
    /** Starts the run's video on this tab, once per thread. */
    readonly startVideo: (
      scope: McpInvocationContext.McpThreadInvocationScope,
      tabId: PreviewTabId,
    ) => Effect.Effect<void>;
    /** Logs a step the agent took, with the user's passwords written as placeholders. */
    readonly stepPerformed: (threadId: ThreadId, step: QaReplayStep) => Effect.Effect<void>;
    /** Finishes the thread's open run of this kind (default exploratory). */
    readonly finish: (
      threadId: ThreadId,
      kind?: QaRun["kind"],
    ) => Effect.Effect<QaRun | null, QaRunError>;
  }
>()("t3/qa/QaRecorder") {}

const make = Effect.gen(function* () {
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const qaRuns = yield* QaRuns.QaRuns;
  const activity = yield* PreviewAgentActivity.PreviewAgentActivity;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const recordings = new Map<
    ThreadId,
    { readonly scope: McpInvocationContext.McpThreadInvocationScope; readonly tabId: PreviewTabId }
  >();

  const browserOpened = Effect.fn("QaRecorder.browserOpened")(
    function* (
      scope: McpInvocationContext.McpThreadInvocationScope,
      opened: PreviewAutomationStatus,
    ) {
      yield* qaRuns.ensureRun(scope.thread.threadId, { site: opened.url });
      if (opened.tabId !== null) yield* startVideo(scope, opened.tabId);
    },
    Effect.catch((error) => Effect.logWarning("QA run could not start", { error })),
  );

  const startVideo = Effect.fn("QaRecorder.startVideo")(
    function* (scope: McpInvocationContext.McpThreadInvocationScope, tabId: PreviewTabId) {
      const threadId = scope.thread.threadId;
      if (recordings.has(threadId)) return;
      yield* broker
        .invoke<PreviewAutomationRecordingStatus>({
          scope,
          operation: "recordingStart",
          input: {},
          tabId,
        })
        .pipe(
          Effect.flatMap((status) =>
            Effect.gen(function* () {
              recordings.set(threadId, { scope, tabId });
              if (status.startedAt) yield* qaRuns.markRecordingStarted(threadId, status.startedAt);
            }),
          ),
          Effect.catch((error) => qaRuns.markVideoUnavailable(threadId, errorReason(error))),
        );
    },
    Effect.catch((error) => Effect.logWarning("QA video could not start", { error })),
  );

  const stepPerformed = Effect.fn("QaRecorder.stepPerformed")(
    function* (threadId: ThreadId, step: QaReplayStep) {
      const saved =
        step.kind === "type"
          ? {
              ...step,
              text: hideSecrets(
                step.text,
                yield* threadProvidedSecretsInOrder(threads, threadId).pipe(
                  Effect.orElseSucceed(() => []),
                ),
              ),
            }
          : step;
      yield* qaRuns.appendStep(threadId, saved);
    },
    Effect.catch((error) => Effect.logWarning("QA step was not logged", { error })),
  );

  const stopRecording = Effect.fn("QaRecorder.stopRecording")(function* (threadId: ThreadId) {
    const recording = recordings.get(threadId);
    if (!recording) return;
    recordings.delete(threadId);
    yield* broker
      .invoke<unknown>({
        scope: recording.scope,
        operation: "recordingStop",
        input: { transferToEnvironment: true },
        tabId: recording.tabId,
        timeoutMs: PREVIEW_RECORDING_STOP_TIMEOUT_MS,
      })
      .pipe(
        Effect.flatMap((response) => claimPreviewRecording(threadId, response)),
        Effect.provideService(ServerConfig.ServerConfig, config),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.flatMap((video) =>
          qaRuns.attachVideo(threadId, { sourcePath: video.path, sizeBytes: video.sizeBytes }),
        ),
        Effect.catch((error) => qaRuns.markVideoUnavailable(threadId, errorReason(error))),
      );
  });

  // "No project" threads live in the scratch project, so a run there belongs to no project.
  const projectOf = Effect.fn("QaRecorder.projectOf")(
    function* (threadId: ThreadId) {
      const shell = yield* threads.getThreadShell(threadId);
      if (shell === null) return null;
      return (yield* managedFolders.isScratchProject(shell.projectId)) ? null : shell.projectId;
    },
    Effect.orElseSucceed(() => null),
  );

  const finish = Effect.fn("QaRecorder.finish")(function* (
    threadId: ThreadId,
    kind: QaRun["kind"] = "exploratory",
  ) {
    const open = yield* qaRuns.openRun(threadId);
    // An agent's turn ending must not stop a replay's video or close its run.
    if (open !== null && open.kind !== kind) return null;
    yield* stopRecording(threadId);
    return yield* qaRuns.finishRun(threadId, { projectId: yield* projectOf(threadId), kind });
  });

  const turns = yield* activity.changes;
  yield* PubSub.take(turns).pipe(
    Effect.flatMap((change) =>
      change.active
        ? Effect.void
        : finish(change.threadId).pipe(
            Effect.catch((error) => Effect.logWarning("QA run could not finish", { error })),
          ),
    ),
    Effect.forever,
    Effect.forkScoped,
  );

  return QaRecorder.of({ browserOpened, startVideo, stepPerformed, finish });
});

export const layer = Layer.effect(QaRecorder, make);
