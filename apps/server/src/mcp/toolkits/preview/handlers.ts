import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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
  type ProjectId,
  type QaReplayStep,
  type QaSavedSecretId,
  type SecretRef,
} from "@t3tools/contracts";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as RouteTrigger from "../../../memory/RouteTrigger.ts";
import * as QaRecorder from "../../../qa/QaRecorder.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as QaSavedSecrets from "../../../qa/QaSavedSecrets.ts";
import { actStep, savedSecretPlaceholder, waitStep } from "../../../qa/qaReplay.ts";
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

/** Adds the landed page's remembered guides and open issues, when there are new ones. */
const withMemoryNote = Effect.fn("PreviewToolkit.withMemoryNote")(function* <A extends object>(
  result: A,
  url: string | null | undefined,
) {
  const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview").pipe(
    Effect.option,
  );
  if (scope._tag === "None" || !scope.value.capabilities.has("memory")) return result;
  const note = yield* (yield* RouteTrigger.RouteTrigger).onPage(
    scope.value.thread.threadId,
    url ?? null,
  );
  return note === null ? result : { ...result, memoryNote: note };
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

/** Swaps a `secretRef` or `savedSecretId` for its value, here, so the agent never sees it. */
const withSecretText = Effect.fn("PreviewToolkit.withSecretText")(function* (
  action: string,
  input: {
    readonly text?: string | undefined;
    readonly secretRef?: SecretRef | undefined;
    readonly savedSecretId?: QaSavedSecretId | undefined;
  },
) {
  const { secretRef, savedSecretId, ...rest } = input;
  const source =
    savedSecretId !== undefined
      ? { saved: savedSecretId }
      : secretRef !== undefined
        ? { ref: secretRef }
        : null;
  if (source === null) return { input: rest, typedSecret: null };
  if (action !== "type")
    return yield* invalidAct("`secretRef` and `savedSecretId` work only with action `type`.");
  if ([rest.text, secretRef, savedSecretId].filter((value) => value !== undefined).length > 1)
    return yield* invalidAct("Pass one of `text`, `secretRef` or `savedSecretId`.");
  const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
  const thread = yield* (yield* ThreadManagementService.ThreadManagementService)
    .getThreadShell(scope.thread.threadId)
    .pipe(Effect.mapError(() => invalidAct("Could not read this thread's project.")));
  if (thread === null) return yield* invalidAct("This thread has no project for its secrets.");
  if ("saved" in source) {
    const saved = yield* (yield* QaSavedSecrets.QaSavedSecrets)
      .read(thread.projectId, source.saved)
      .pipe(Effect.mapError((error) => invalidAct(error.message)));
    if (Option.isNone(saved))
      return yield* invalidAct(
        "No saved password with that id in this project. Ask with request_secret instead.",
      );
    return {
      input: { ...rest, text: saved.value },
      typedSecret: { kind: "saved" as const, secretId: source.saved },
    };
  }
  const { value, remember } = yield* (yield* SecretRequests.SecretRequests)
    .consumeDetailed({ ref: source.ref, projectId: thread.projectId })
    .pipe(Effect.mapError((error) => invalidAct(error.message)));
  return {
    input: { ...rest, text: value },
    typedSecret: { kind: "requested" as const, projectId: thread.projectId, value, remember },
  };
});

const ONE_USE_STEP = "A one-use secret was typed, so a replay cannot type it again.";

type TypedSecret =
  | { readonly kind: "saved"; readonly secretId: QaSavedSecretId }
  | {
      readonly kind: "requested";
      readonly projectId: ProjectId;
      readonly value: string;
      readonly remember: SecretRequests.RememberRequest | undefined;
    };

/** The QA step for a typed secret: a saved placeholder when the value is in the project's vault. */
const secretStep = Effect.fn("PreviewToolkit.secretStep")(function* (
  typed: TypedSecret,
  decoded: Readonly<Record<string, unknown>>,
  target: PreviewAutomationDurableTarget | null,
) {
  if (typed.kind === "saved")
    return actStep("type", { ...decoded, text: savedSecretPlaceholder(typed.secretId) }, target);
  const unreplayable: QaReplayStep = { kind: "unreplayable", action: "type", reason: ONE_USE_STEP };
  if (typed.remember === undefined) return unreplayable;
  const secretId = yield* (yield* QaSavedSecrets.QaSavedSecrets)
    .remember({ projectId: typed.projectId, ...typed.remember, value: typed.value })
    .pipe(
      Effect.tapError((error) =>
        Effect.logWarning("A typed secret could not be remembered", { error: error.message }),
      ),
      Effect.option,
    );
  return Option.isNone(secretId)
    ? unreplayable
    : actStep("type", { ...decoded, text: savedSecretPlaceholder(secretId.value) }, target);
});

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
      return yield* withMemoryNote(result, result.url);
    }),
  ),
  preview_navigate: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationStatus>("navigate", input, input.timeoutMs).pipe(
      Effect.tap((status) => {
        const url = requestedUrl(input) ?? status.url;
        return url === null ? Effect.void : logStep({ kind: "navigate", url });
      }),
      Effect.flatMap((status) => withMemoryNote(status, status.url)),
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
        typedSecret === null
          ? actStep(action, decoded, target)
          : yield* secretStep(typedSecret, decoded, target),
      );
      const pageUrl =
        "toolIcon" in result && result.toolIcon?._tag === "website"
          ? result.toolIcon.pageUrl
          : null;
      return yield* withMemoryNote(result, pageUrl);
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
