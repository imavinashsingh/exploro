import * as Effect from "effect/Effect";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import {
  PREVIEW_RECORDING_STOP_TIMEOUT_MS,
  PreviewAutomationActInputs,
  OrchestratorMcpFailure,
  type ToolActivityIcon,
  type PreviewAutomationOperation,
  type PreviewAutomationOpenInput,
  type PreviewAutomationRecordingStatus,
  type PreviewAutomationResizeResult,
  type PreviewAutomationSetColorSchemeResult,
  type PreviewAutomationSnapshot,
  type PreviewAutomationSnapshotMetadata,
  type PreviewAutomationStatus,
  type PreviewAutomationDurableTarget,
  type PreviewTabId,
  type QaReplayStep,
  type SecretRef,
} from "@t3tools/contracts";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as QaRecorder from "../../../qa/QaRecorder.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import { actStep, waitStep } from "../../../qa/qaReplay.ts";
import { claimPreviewRecording } from "./recordingClaim.ts";
import { PreviewSnapshotToolkit, PreviewStandardToolkit, PreviewToolkit } from "./tools.ts";

/** Whether a preview the agent
 * said nothing about surfaces is the user's `browserAutoShowFloatingPreview`
 * preference, which is desktop-local and unreadable from here — filling in
 * `true` would silently override it for every `preview_open`.
 */
function normalizePreviewOpenInput(input: PreviewAutomationOpenInput): PreviewAutomationOpenInput {
  const open = input.open ?? input.show;
  return {
    ...input,
    ...(open === undefined ? {} : { open, show: open }),
    reuseExistingTab: input.reuseExistingTab ?? true,
  };
}

const invoke = Effect.fn("PreviewToolkit.invoke")(function* <A>(
  operation: PreviewAutomationOperation,
  input: unknown,
  timeoutMs?: number,
  tabId?: PreviewTabId,
): Effect.fn.Return<
  { result: A; toolIcon?: ToolActivityIcon },
  import("@t3tools/contracts").PreviewAutomationError,
  McpInvocationContext.McpInvocationContext | PreviewAutomationBroker.PreviewAutomationBroker
> {
  const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  let targetTabId = tabId;
  const result = yield* broker.invoke<A>({
    onTargetTab: (resolvedTabId) => {
      targetTabId = resolvedTabId;
    },
    scope,
    operation,
    input,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(tabId === undefined ? {} : { tabId }),
  });
  if (["status", "open", "navigate", "snapshot"].includes(operation)) return { result };
  const statusTabId =
    (operation !== "evaluate" && typeof result === "object" && result !== null
      ? (result as { tabId?: PreviewTabId }).tabId
      : undefined) ?? targetTabId;
  const page = yield* broker
    .invoke<PreviewAutomationStatus>({
      scope,
      operation: "status",
      input: {},
      timeoutMs: 500,
      updateCurrentTab: false,
      ...(statusTabId === undefined ? {} : { tabId: statusTabId }),
    })
    .pipe(Effect.orElseSucceed(() => null));
  return {
    result,
    ...(page?.url && /^https?:\/\//i.test(page.url) && page.url.length <= 4096
      ? { toolIcon: { _tag: "website" as const, pageUrl: page.url } }
      : {}),
  };
});

const invokeTargeted = <A extends object>(
  operation: PreviewAutomationOperation,
  input: {
    readonly tabId?: PreviewTabId | undefined;
    readonly [key: string]: unknown;
  },
  timeoutMs?: number,
) => {
  const { tabId, ...operationInput } = input;
  return invoke<A>(operation, operationInput, timeoutMs, tabId).pipe(
    Effect.map(({ result, toolIcon }) => ({
      ...result,
      ...(toolIcon ? { toolIcon } : {}),
    })),
  );
};

/** Logs a step for the thread's QA run; a logging failure never fails the agent's action. */
const logStep = Effect.fn("PreviewToolkit.logStep")(function* (step: QaReplayStep) {
  const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview").pipe(
    Effect.option,
  );
  if (scope._tag === "None") return;
  yield* (yield* QaRecorder.QaRecorder).stepPerformed(scope.value.thread.threadId, step);
});

/** Splits off the target the browser named for the step, which the agent does not need. */
const takeRecordedTarget = <A extends object>(result: A) => {
  const { recordedTarget, ...rest } = result as A & {
    readonly recordedTarget?: PreviewAutomationDurableTarget;
  };
  return { target: recordedTarget ?? null, result: rest };
};

const requestedUrl = (input: {
  readonly url?: string | undefined;
  readonly target?: { readonly kind: string; readonly url?: string } | undefined;
}) => input.url ?? (input.target?.kind === "url" ? input.target.url : undefined);

const decodeActInput = Record.map(PreviewAutomationActInputs, (schema) =>
  Schema.decodeUnknownEffect(schema),
);

const invalidAct = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/** Swaps a `secretRef` for its value, here, so the agent never sees it. */
const withSecretText = Effect.fn("PreviewToolkit.withSecretText")(function* (
  action: string,
  input: { readonly text?: string | undefined; readonly secretRef?: SecretRef | undefined },
) {
  const { secretRef, ...rest } = input;
  if (secretRef === undefined) return { input: rest, typedSecret: false };
  if (action !== "type") return yield* invalidAct("`secretRef` works only with action `type`.");
  if (rest.text !== undefined) return yield* invalidAct("Pass one of `text` or `secretRef`.");
  const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
  const thread = yield* (yield* ThreadManagementService.ThreadManagementService)
    .getThreadShell(scope.thread.threadId)
    .pipe(Effect.mapError(() => invalidAct("Could not read this thread's project.")));
  if (thread === null) return yield* invalidAct("This thread has no project for its secrets.");
  const value = yield* (yield* SecretRequests.SecretRequests)
    .consume({ ref: secretRef, projectId: thread.projectId })
    .pipe(Effect.mapError((error) => invalidAct(error.message)));
  return { input: { ...rest, text: value }, typedSecret: true };
});

const ONE_USE_STEP = "A one-use secret was typed, so a replay cannot type it again.";

const handlers = {
  preview_dialog: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationStatus>("dialog", input).pipe(
      Effect.tap(() =>
        logStep({
          kind: "unreplayable",
          action: "dialog",
          reason: "Answering a dialog is not replayed yet.",
        }),
      ),
    ),
  ),
  preview_status: McpToolAccess.readsAsCaller((input) =>
    invokeTargeted<PreviewAutomationStatus>("status", input ?? {}),
  ),
  // Models often pass a dev server as both `url` and `target`; the target knows the environment.
  preview_open: McpToolAccess.actsAsCaller(({ target, url, ...input }) =>
    Effect.gen(function* () {
      const opened = yield* invokeTargeted<PreviewAutomationStatus>(
        "open",
        normalizePreviewOpenInput(
          target === undefined && url !== undefined ? { ...input, url } : input,
        ),
      );
      const result =
        target === undefined || opened.tabId === null
          ? opened
          : yield* invokeTargeted<PreviewAutomationStatus>("navigate", {
              target,
              tabId: opened.tabId,
            });
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
      yield* (yield* QaRecorder.QaRecorder).browserOpened(scope, result);
      const startUrl = (target === undefined ? url : undefined) ?? result.url;
      if (startUrl !== null && /^https?:\/\//i.test(startUrl))
        yield* logStep({ kind: "navigate", url: startUrl });
      return result;
    }),
  ),
  preview_navigate: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationStatus>("navigate", input, input.timeoutMs).pipe(
      Effect.tap((status) => {
        const url = requestedUrl(input) ?? status.url;
        return url === null ? Effect.void : logStep({ kind: "navigate", url });
      }),
    ),
  ),
  preview_resize: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationResizeResult>("resize", input, input.timeoutMs).pipe(
      Effect.tap(() =>
        logStep({
          kind: "unreplayable",
          action: "resize",
          reason: "Viewport changes are not replayed yet.",
        }),
      ),
    ),
  ),
  preview_set_appearance: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationSetColorSchemeResult>("setColorScheme", input),
  ),
  preview_snapshot: McpToolAccess.readsAsCaller((input) => {
    const { includeImage, save, ...operationInput } = input ?? {};
    // The saved file is for people, so it keeps the resolution the agent's image is capped below.
    return invokeTargeted<PreviewAutomationSnapshot | PreviewAutomationSnapshotMetadata>(
      "snapshot",
      {
        ...operationInput,
        ...(save === true ? { fullScreenshot: true } : {}),
        ...(includeImage === true || save === true ? {} : { pixelsRequired: false }),
      },
    );
  }),
  preview_act: McpToolAccess.actsAsCaller(({ action, ...input }) =>
    Effect.gen(function* () {
      const { input: resolved, typedSecret } = yield* withSecretText(action, input);
      const decoded = yield* decodeActInput[action](resolved).pipe(
        Effect.mapError((cause) => invalidAct(cause.message)),
      );
      const raw = yield* invokeTargeted<object>(
        action,
        decoded,
        "timeoutMs" in decoded ? decoded.timeoutMs : undefined,
      );
      const { target, result } = takeRecordedTarget(raw);
      yield* logStep(
        typedSecret
          ? { kind: "unreplayable", action: "type", reason: ONE_USE_STEP }
          : actStep(action, decoded, target),
      );
      return result;
    }),
  ),
  preview_evaluate: McpToolAccess.actsAsCaller(({ tabId, ...input }) =>
    invoke<unknown>("evaluate", input, undefined, tabId).pipe(
      Effect.map(({ result, toolIcon }) => ({
        value: result ?? null,
        ...(toolIcon ? { toolIcon } : {}),
      })),
    ),
  ),
  preview_wait_for: McpToolAccess.readsAsCaller((input) =>
    invokeTargeted<object>("waitFor", input, input.timeoutMs).pipe(
      Effect.flatMap((raw) => {
        const { target, result } = takeRecordedTarget(raw);
        const hadLocator = input.locator !== undefined || input.selector !== undefined;
        return logStep(waitStep(input, hadLocator, target)).pipe(Effect.as(result));
      }),
    ),
  ),
  preview_recording_start: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationRecordingStatus>("recordingStart", input ?? {}),
  ),
  preview_recording_stop: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
      const { tabId, ...operationInput } = input;
      const response = yield* invoke<unknown>(
        "recordingStop",
        { ...operationInput, transferToEnvironment: true },
        PREVIEW_RECORDING_STOP_TIMEOUT_MS,
        tabId,
      );
      const artifact = yield* claimPreviewRecording(scope.thread.threadId, response.result);
      return { ...artifact, ...(response.toolIcon ? { toolIcon: response.toolIcon } : {}) };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof PreviewToolkit.tools>;

const { preview_snapshot, ...standardHandlers } = handlers;

export const layerStandard = McpToolAccess.toLayer(PreviewStandardToolkit, standardHandlers);

export const layerSnapshot = McpToolAccess.toLayer(PreviewSnapshotToolkit, {
  preview_snapshot,
});
