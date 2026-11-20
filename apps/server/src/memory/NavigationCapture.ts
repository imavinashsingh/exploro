import {
  ProjectMemoryError,
  type NavigationObserveInput,
  type NavigationRouteResult,
  type NavigationState,
  type PreviewAutomationCheckResult,
  type PreviewAutomationStatus,
  type PreviewTabId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as QaRuns from "../qa/QaRuns.ts";
import { assertionFor, checkFor } from "../qa/qaReplay.ts";
import { redactText } from "../qa/qaEvidence.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectNavigationMemory from "./ProjectNavigationMemory.ts";
import { navigationRoute } from "./ProjectNavigationMemory.ts";
import { navigationDestinations } from "./navigation.ts";
import { hideProvidedSecrets, threadProvidedSecrets } from "./providedSecrets.ts";

type Scope = McpInvocationContext.McpThreadInvocationScope;
export class NavigationCapture extends Context.Service<
  NavigationCapture,
  {
    readonly observe: (
      scope: Scope,
      input: NavigationObserveInput,
    ) => Effect.Effect<NavigationState, ProjectMemoryError>;
    readonly route: (
      scope: Scope,
      input: {
        fromStateId?: string | undefined;
        destination: string;
        tabId?: PreviewTabId | undefined;
      },
    ) => Effect.Effect<NavigationRouteResult, ProjectMemoryError>;
    readonly feedback: (
      scope: Scope,
      input: { transitionId: string; outcome: "mismatch" | "tool-error" },
    ) => Effect.Effect<void, ProjectMemoryError>;
  }
>()("t3/memory/NavigationCapture") {}

const isMemoryError = Schema.is(ProjectMemoryError);
const failure = (cause: unknown) =>
  isMemoryError(cause)
    ? cause
    : new ProjectMemoryError({ message: "Could not use navigation memory.", cause });
const make = Effect.gen(function* () {
  const memory = yield* ProjectNavigationMemory.ProjectNavigationMemory;
  const settings = yield* ServerSettings.ServerSettingsService;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const runs = yield* QaRuns.QaRuns;

  const access = Effect.fn("NavigationCapture.access")(function* (scope: Scope) {
    const thread = yield* threads.getThreadShell(scope.thread.threadId);
    if (thread === null || (yield* folders.isScratchProject(thread.projectId)))
      return yield* new ProjectMemoryError({ message: "Navigation memory needs a project." });
    const current = resolveProjectSettings(yield* settings.getSettings, thread.projectId).settings;
    if (!current.qaNavigationMemory)
      return yield* new ProjectMemoryError({ message: "Project Navigation Memory is off." });
    return {
      projectId: thread.projectId,
      origins: current.qaSiteOrigins,
    };
  });
  const page = Effect.fn("NavigationCapture.page")(function* (scope: Scope, tabId?: PreviewTabId) {
    let actualTab = tabId;
    // Status, not a snapshot: a snapshot would revoke the element refs the agent is using.
    const status = yield* broker.invoke<PreviewAutomationStatus>({
      scope,
      operation: "status",
      input: {},
      ...(tabId === undefined ? {} : { tabId }),
      onTargetTab: (value) => {
        actualTab = value;
      },
    });
    actualTab ??= status.tabId ?? undefined;
    if (actualTab === undefined)
      return yield* new ProjectMemoryError({
        message: "The browser did not identify its current tab.",
      });
    const url = yield* Effect.try({
      try: () => new URL(status.url ?? ""),
      catch: () =>
        new ProjectMemoryError({ message: "The current page has no valid website URL." }),
    });
    if (!["https:", "http:"].includes(url.protocol))
      return yield* new ProjectMemoryError({
        message: "Navigation memory supports website pages only.",
      });
    const stepIndex = Date.parse(status.lastActionAt ?? "") || 0;
    return { url, tabId: actualTab, stepIndex };
  });

  // An unknown start still lets a single remembered destination be opened by its address.
  const unrecognized = (states: ReadonlyArray<NavigationState>, destination: string) => {
    const [target, ...others] = navigationDestinations(states, destination);
    return {
      status: "unrecognized" as const,
      candidates: [],
      ...(target === undefined || others.length > 0
        ? {}
        : { directUrl: `${target.environment}${target.path}` }),
      steps: [],
    };
  };

  // Remembered screens at this address that the live page still satisfies, most specific first.
  const recognize = Effect.fn("NavigationCapture.recognize")(function* (
    scope: Scope,
    tabId: PreviewTabId,
    candidates: ReadonlyArray<NavigationState>,
  ) {
    const verified = yield* Effect.forEach(candidates.slice(0, 8), (state) =>
      broker
        .invoke<PreviewAutomationCheckResult>({
          scope,
          tabId,
          operation: "check",
          input: { assertions: state.checks.map(assertionFor), timeoutMs: 1500 },
        })
        .pipe(
          Effect.map((result) =>
            result.results.length === state.checks.length &&
            result.results.every((check) => check.ok)
              ? [state]
              : [],
          ),
        ),
    );
    return verified.flat().toSorted((a, b) => b.checks.length - a.checks.length);
  });
  const atAddress = (states: ReadonlyArray<NavigationState>, url: URL) =>
    states.filter((state) => state.environment === url.origin && state.path === url.pathname);

  return NavigationCapture.of({
    observe: Effect.fn("NavigationCapture.observe")(function* (scope, input) {
      const { projectId, origins } = yield* access(scope);
      const current = yield* page(scope, input.tabId);
      const run = yield* runs.ensureRun(scope.thread.threadId, { site: current.url.origin });
      const allowed = new Set(
        origins.length > 0 ? origins : run.site === null ? [] : [new URL(run.site).origin],
      );
      if (!allowed.has(current.url.origin))
        return yield* new ProjectMemoryError({
          message: "This page is outside the project's tested sites.",
        });
      if (input.checks.every((check) => check.kind === "urlIncludes"))
        return yield* new ProjectMemoryError({
          message: "Identify the screen with a visible control or text, not only a URL.",
        });
      if (input.checks.some((check) => check.kind === "valueEquals"))
        return yield* new ProjectMemoryError({
          message: "Use visible controls or labels rather than personal field values.",
        });
      const checked = yield* broker.invoke<PreviewAutomationCheckResult>({
        scope,
        tabId: current.tabId,
        operation: "check",
        input: { assertions: input.checks, timeoutMs: 1500 },
      });
      const checks = input.checks.flatMap((check, index) => {
        const result = checked.results[index];
        const saved = result?.ok === true ? checkFor(check, result.target) : null;
        return saved === null ? [] : [saved];
      });
      if (checks.length !== input.checks.length)
        return yield* new ProjectMemoryError({
          message: "The live page did not verify every state check.",
        });
      const after = yield* page(scope, current.tabId);
      if (after.url.href !== current.url.href)
        return yield* new ProjectMemoryError({
          message: "The page changed while its state was being recorded.",
        });
      const secrets = yield* threadProvidedSecrets(threads, scope.thread.threadId);
      const hide = (text: string) => redactText(hideProvidedSecrets(text, secrets));
      if (checks.some((check) => hide(JSON.stringify(check)) !== JSON.stringify(check)))
        return yield* new ProjectMemoryError({
          message: "Choose screen checks without credentials or personal field values.",
        });
      const stepIndex = current.stepIndex;
      const name = hide(input.name);
      const aliases = input.aliases.map(hide);
      const context = Object.fromEntries(
        Object.entries(input.context).map(([key, value]) => [hide(key), hide(value)]),
      );
      // A screen the live page already satisfies keeps one identity, whatever the model calls it.
      const [known] = yield* recognize(
        scope,
        current.tabId,
        atAddress((yield* memory.snapshot(projectId)).states, current.url).filter((state) =>
          Object.entries(context).every(
            ([key, value]) => state.context[key] === undefined || state.context[key] === value,
          ),
        ),
      );
      return yield* memory.observe(projectId, {
        state:
          known === undefined
            ? {
                name,
                aliases,
                environment: current.url.origin,
                path: current.url.pathname,
                context,
                checks,
              }
            : {
                ...known,
                aliases: [...new Set([...known.aliases, name, ...aliases])]
                  .filter((alias) => alias !== known.name)
                  .slice(0, 10),
              },
        threadId: scope.thread.threadId,
        runId: run.runId,
        tabId: current.tabId,
        stepIndex,
        ...(input.action === undefined ? {} : { action: hide(input.action) }),
      });
    }, Effect.mapError(failure)),
    route: Effect.fn("NavigationCapture.route")(function* (scope, input) {
      const { projectId } = yield* access(scope);
      const current = yield* page(scope, input.tabId);
      const snapshot = yield* memory.snapshot(projectId);
      const states = snapshot.states.filter((state) => state.environment === current.url.origin);
      const here = atAddress(states, current.url);
      const starts = (yield* recognize(scope, current.tabId, here)).toSorted(
        (a, b) => Number(b.id === input.fromStateId) - Number(a.id === input.fromStateId),
      );
      // Every screen the live page satisfies is a valid start; the first with a path wins.
      const routes = starts.map((start) =>
        navigationRoute({ ...snapshot, states }, start.id, input.destination),
      );
      return (
        routes.find((route) => route.status === "found" || route.status === "already-there") ??
        routes[0] ??
        unrecognized(states, input.destination)
      );
    }, Effect.mapError(failure)),
    feedback: Effect.fn("NavigationCapture.feedback")(function* (scope, input) {
      const { projectId } = yield* access(scope);
      const run = yield* runs.openRun(scope.thread.threadId);
      if (run === null)
        return yield* new ProjectMemoryError({
          message: "Observe the current run before reporting a mismatch.",
        });
      yield* memory.feedback(projectId, run.runId, input.transitionId, input.outcome);
    }, Effect.mapError(failure)),
  });
});
export const layer = Layer.effect(NavigationCapture, make);
