import {
  INCOGNITO_BROWSER_PROFILE_ID,
  ProviderInstanceId,
  QaRunError,
  QaSuite,
  qaSiteOrigin,
  type PreviewAutomationCheckResult,
  type PreviewAutomationStatus,
  type PreviewTabId,
  type QaReplayStep,
  type QaRun,
  type QaSavedSecretId,
  type QaSuiteCreateInput,
  type QaSuiteCreateResult,
  type QaSuiteId,
  type QaSuiteRunInput,
  type QaSuiteRunStarted,
  type QaSuiteSummary,
  type QaSuitesSnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import { threadProvidedSecretsInOrder } from "../memory/providedSecrets.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as PreviewAgentActivity from "../preview/PreviewAgentActivity.ts";
import { capturePage } from "./qaCapture.ts";
import * as QaRecorder from "./QaRecorder.ts";
import {
  assertionFor,
  buildSuite,
  describeCheck,
  describeStep,
  fillSavedSecrets,
  fillSecrets,
  rebaseUrl,
  savedSecretIds,
} from "./qaReplay.ts";
import * as QaRuns from "./QaRuns.ts";
import * as QaSavedSecrets from "./QaSavedSecrets.ts";

const STEP_TIMEOUT_MS = 15_000;
const CHECK_TIMEOUT_MS = 5_000;
const SETTLE_TIMEOUT_MS = 10_000;

export class QaSuites extends Context.Service<
  QaSuites,
  {
    readonly create: (input: QaSuiteCreateInput) => Effect.Effect<QaSuiteCreateResult, QaRunError>;
    readonly list: Effect.Effect<ReadonlyArray<QaSuiteSummary>, QaRunError>;
    readonly subscribe: Stream.Stream<QaSuitesSnapshot, QaRunError>;
    readonly delete: (suiteId: QaSuiteId) => Effect.Effect<{ suiteId: QaSuiteId }, QaRunError>;
    /** Starts a replay in the suite's thread and returns at once. */
    readonly start: (input: QaSuiteRunInput) => Effect.Effect<QaSuiteRunStarted, QaRunError>;
    /** Replays the suite and returns the finished run. */
    readonly run: (input: QaSuiteRunInput) => Effect.Effect<QaRun, QaRunError>;
    readonly forgetSecret: (secretId: QaSavedSecretId) => Effect.Effect<void, QaRunError>;
  }
>()("t3/qa/QaSuites") {}

const SuiteJson = Schema.fromJsonString(QaSuite);
const decodeSuite = Schema.decodeUnknownOption(SuiteJson);
const encodeSuite = Schema.encodeEffect(SuiteJson);
const failure = (message: string) => (cause: unknown) => new QaRunError({ message, cause });

const errorMessage = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message).split("\n")[0]
    : "The browser did not answer.";

const summaryOf = (suite: QaSuite): QaSuiteSummary => ({
  suiteId: suite.suiteId,
  name: suite.name,
  createdAt: suite.createdAt,
  projectId: suite.projectId,
  sourceThreadId: suite.sourceThreadId,
  site: suite.site,
  scenarioCount: suite.scenarios.length,
  stepCount: suite.steps.length,
});

const defaultName = (run: QaRun) => {
  const origin = run.site === null ? null : qaSiteOrigin(run.site);
  const host = origin === null ? "Regression" : new URL(origin).host;
  return `${host} · ${run.startedAt.slice(0, 10)}`;
};

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const qaRuns = yield* QaRuns.QaRuns;
  const savedSecrets = yield* QaSavedSecrets.QaSavedSecrets;
  const recorder = yield* QaRecorder.QaRecorder;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const activity = yield* PreviewAgentActivity.PreviewAgentActivity;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const replays = yield* Effect.scope;
  const changes = yield* PubSub.unbounded<void>();
  const lock = yield* Semaphore.make(1);
  const suitesDir = path.join(config.stateDir, "qa-suites");
  const suitePath = (suiteId: QaSuiteId) => path.join(suitesDir, `${suiteId}.json`);
  let cache: ReadonlyArray<QaSuite> | null = null;

  const load = Effect.fn("QaSuites.load")(
    function* () {
      if (cache !== null) return cache;
      const names = yield* fileSystem.readDirectory(suitesDir).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed([] as Array<string>),
        ),
      );
      const suites: Array<QaSuite> = [];
      for (const name of names.filter((entry) => entry.endsWith(".json"))) {
        const text = yield* fileSystem
          .readFileString(path.join(suitesDir, name))
          .pipe(Effect.orElseSucceed(() => ""));
        const suite = decodeSuite(text);
        if (suite._tag === "Some") suites.push(suite.value);
      }
      suites.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      cache = suites;
      return suites;
    },
    Effect.mapError(failure("Could not read the regression suites.")),
  );

  const find = Effect.fn("QaSuites.find")(function* (suiteId: QaSuiteId) {
    const suite = (yield* lock.withPermit(load())).find((entry) => entry.suiteId === suiteId);
    if (suite === undefined)
      return yield* new QaRunError({ message: "That regression suite no longer exists." });
    return suite;
  });

  const create = Effect.fn("QaSuites.create")(function* (input: QaSuiteCreateInput) {
    const run = (yield* qaRuns.list(input.threadId)).find((entry) => entry.runId === input.runId);
    if (run === undefined)
      return yield* new QaRunError({ message: "That QA run no longer exists." });
    if (run.finishedAt === null)
      return yield* new QaRunError({ message: "Finish the run before saving it as a suite." });
    if (run.kind === "regression")
      return yield* new QaRunError({ message: "Save a suite from a test run, not from a replay." });
    const built = buildSuite(run, yield* qaRuns.readSteps(run));
    if (built.scenarios.length === 0)
      return yield* new QaRunError({
        message: `No scenario of this run can be replayed. ${built.skipped
          .map((skip) => `${skip.scenario}: ${skip.reason}`)
          .join(" ")}`,
      });
    const createdAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    const suite: QaSuite = {
      suiteId: `suite-${(yield* random.uuidV4()).slice(0, 13)}`,
      name: input.name ?? defaultName(run),
      createdAt,
      projectId: run.projectId,
      sourceThreadId: run.threadId,
      sourceRunId: run.runId,
      site: run.site,
      steps: [...built.steps],
      scenarios: [...built.scenarios],
    };
    yield* lock.withPermit(
      Effect.gen(function* () {
        const existing = yield* load();
        yield* fileSystem.makeDirectory(suitesDir, { recursive: true });
        yield* writeFileStringAtomically({
          filePath: suitePath(suite.suiteId),
          contents: `${yield* encodeSuite(suite)}\n`,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
        cache = [suite, ...existing];
      }).pipe(Effect.mapError(failure("Could not save the regression suite."))),
    );
    yield* PubSub.publish(changes, undefined);
    return { suite: summaryOf(suite), skipped: built.skipped };
  });

  const deleteSuite = Effect.fn("QaSuites.delete")(function* (suiteId: QaSuiteId) {
    yield* find(suiteId);
    yield* lock.withPermit(
      fileSystem.remove(suitePath(suiteId)).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            cache = cache?.filter((suite) => suite.suiteId !== suiteId) ?? null;
          }),
        ),
        Effect.mapError(failure("Could not delete the regression suite.")),
      ),
    );
    yield* PubSub.publish(changes, undefined);
    return { suiteId };
  });

  /** A browser session of its own, so the replay never acts on an agent's tab. */
  const replayScope = (
    threadId: ThreadId,
    runId: string,
    issuedAt: number,
  ): McpInvocationContext.McpThreadInvocationScope => ({
    environmentId,
    requestNamespace: `regression:${runId}`,
    thread: {
      threadId,
      providerSessionId: `regression:${runId}`,
      providerInstanceId: ProviderInstanceId.make("regression"),
    },
    client: undefined,
    capabilities: new Set(["preview"]),
    issuedAt,
  });

  const stepRequest = (step: QaReplayStep) => {
    const timeout = { timeoutMs: STEP_TIMEOUT_MS };
    switch (step.kind) {
      case "navigate":
        return { operation: "navigate", input: { url: step.url, ...timeout } } as const;
      case "click":
        return {
          operation: "click",
          input: {
            locator: step.target.selector,
            ...(step.button === undefined ? {} : { button: step.button }),
            ...(step.clickCount === undefined ? {} : { clickCount: step.clickCount }),
            ...timeout,
          },
        } as const;
      case "clickAt":
        return { operation: "click", input: { x: step.x, y: step.y, ...timeout } } as const;
      case "type":
        return {
          operation: "type",
          input: {
            text: step.text,
            ...(step.target === null ? {} : { locator: step.target.selector }),
            ...(step.clear === undefined ? {} : { clear: step.clear }),
            ...timeout,
          },
        } as const;
      case "hover":
        return {
          operation: "hover",
          input: { locator: step.target.selector, ...timeout },
        } as const;
      case "select":
        return {
          operation: "select",
          input: { locator: step.target.selector, values: step.values, ...timeout },
        } as const;
      case "press":
        return {
          operation: "press",
          input: { key: step.key, ...(step.modifiers ? { modifiers: step.modifiers } : {}) },
        } as const;
      case "scroll":
        return {
          operation: "scroll",
          input: {
            ...(step.target === null ? {} : { locator: step.target.selector }),
            ...(step.deltaX === undefined ? {} : { deltaX: step.deltaX }),
            ...(step.deltaY === undefined ? {} : { deltaY: step.deltaY }),
          },
        } as const;
      case "waitFor":
        return {
          operation: "waitFor",
          input: {
            ...(step.target === null ? {} : { locator: step.target.selector }),
            ...(step.text === undefined ? {} : { text: step.text }),
            ...(step.urlIncludes === undefined ? {} : { urlIncludes: step.urlIncludes }),
            ...timeout,
          },
        } as const;
      case "unreplayable":
        return null;
    }
  };

  /** Steps with the suite's passwords filled in and its origin moved to `baseUrl`. */
  const prepareSteps = Effect.fn("QaSuites.prepareSteps")(function* (
    suite: QaSuite,
    baseUrl: string | undefined,
  ) {
    const secrets = yield* threadProvidedSecretsInOrder(threads, suite.sourceThreadId).pipe(
      Effect.mapError(failure("Could not read the suite's thread.")),
    );
    const origin = suite.site === null ? null : qaSiteOrigin(suite.site);
    const steps: Array<QaReplayStep> = [];
    for (const step of suite.steps) {
      if (step.kind === "navigate") {
        steps.push({ ...step, url: rebaseUrl(step.url, origin, baseUrl) });
      } else if (step.kind === "type") {
        const filled = fillSecrets(step.text, secrets);
        if ("missing" in filled)
          return yield* new QaRunError({
            message: `The suite types password ${filled.missing} from its thread, which the thread no longer has.`,
          });
        const saved = new Map<string, string>();
        for (const secretId of savedSecretIds(filled.text)) {
          const value =
            suite.projectId === null
              ? Option.none<string>()
              : yield* savedSecrets.read(suite.projectId, secretId);
          if (Option.isNone(value))
            return yield* new QaRunError({
              message:
                "The suite types a saved password that was removed. Sign in again in a test run, tick Remember on the password card, and save the suite again.",
            });
          saved.set(secretId, value.value);
        }
        steps.push({ ...step, text: fillSavedSecrets(filled.text, saved) });
      } else steps.push(step);
    }
    return steps;
  });

  const replay = Effect.fn("QaSuites.replay")(function* (
    suite: QaSuite,
    run: QaRun,
    steps: ReadonlyArray<QaReplayStep>,
  ) {
    const threadId = suite.sourceThreadId;
    // Typed text is described as saved, so reports show placeholders, never the filled passwords.
    const described = steps.map((step, index) =>
      describeStep(step.kind === "type" ? (suite.steps[index] ?? step) : step),
    );
    const scope = replayScope(threadId, run.runId, yield* Clock.currentTimeMillis);
    let tabId: PreviewTabId | undefined;
    const invoke = <A>(operation: string, input: unknown, timeoutMs = STEP_TIMEOUT_MS + 5_000) =>
      broker.invoke<A>({
        scope,
        operation: operation as PreviewAutomationBroker.PreviewAutomationInvokeInput["operation"],
        input: { ...(input as object), ...(tabId === undefined ? {} : { tabId }) },
        timeoutMs,
        ...(tabId === undefined ? {} : { tabId }),
      });
    const settleAndCheck = (assertions: ReadonlyArray<ReturnType<typeof assertionFor>>) =>
      invoke<PreviewAutomationCheckResult>(
        "check",
        { assertions, settle: true, timeoutMs: CHECK_TIMEOUT_MS },
        SETTLE_TIMEOUT_MS + assertions.length * CHECK_TIMEOUT_MS + 5_000,
      );

    yield* Effect.gen(function* () {
      // A fresh incognito tab: no cookies or logins from earlier runs change what the steps do.
      const opened = yield* invoke<PreviewAutomationStatus>("open", {
        reuseExistingTab: false,
        profileId: INCOGNITO_BROWSER_PROFILE_ID,
      });
      tabId = opened.tabId ?? undefined;
      if (tabId !== undefined) yield* recorder.startVideo(scope, tabId);

      let next = 0;
      let broken: string | null = null;
      for (const scenario of suite.scenarios) {
        const stepsText = described.slice(next, scenario.stepCount).slice(-30);
        const record = (input: {
          readonly verdict: "PASS" | "FAIL" | "INCONCLUSIVE";
          readonly note: string;
          readonly expected?: string;
          readonly actual?: string;
        }) =>
          capturePage(broker, scope, tabId).pipe(
            Effect.orElseSucceed(() => ({
              url: null,
              title: null,
              png: null,
              consoleEntries: [],
              networkEntries: [],
              actionTimeline: [],
            })),
            Effect.flatMap((page) =>
              qaRuns.recordReplayedScenario(
                threadId,
                {
                  scenario: scenario.scenario.slice(0, 200),
                  steps: stepsText,
                  ...input,
                  ...(input.verdict === "FAIL" ? { severity: "major" as const } : {}),
                },
                page,
                { checks: scenario.checks, stepCount: scenario.stepCount },
              ),
            ),
          );
        if (broken !== null) {
          yield* record({ verdict: "INCONCLUSIVE", note: `Not run: ${broken}` });
          continue;
        }
        for (; next < scenario.stepCount; next++) {
          const step = steps[next];
          const request = step === undefined ? null : stepRequest(step);
          const failed =
            step === undefined || request === null
              ? "The step cannot be replayed."
              : yield* invoke(request.operation, request.input).pipe(
                  // Wait for what the step set off before the next step looks for its target.
                  Effect.andThen(settleAndCheck([])),
                  Effect.as(null),
                  Effect.catch((error) => Effect.succeed(errorMessage(error))),
                );
          if (failed !== null) {
            const named = `step ${next + 1}${step === undefined ? "" : ` (${described[next]})`}`;
            broken = `${named} broke earlier.`;
            yield* record({
              verdict: "INCONCLUSIVE",
              note: `Test broken: ${named} could not run. ${failed} The page may have changed; this is not a product verdict.`,
            });
            break;
          }
        }
        if (broken !== null) continue;
        const assertions = scenario.checks.map(assertionFor);
        const checked = yield* settleAndCheck(assertions).pipe(
          Effect.map((result) => ({ ok: true as const, result })),
          Effect.catch((error) =>
            Effect.succeed({ ok: false as const, error: errorMessage(error) }),
          ),
        );
        if (!checked.ok) {
          yield* record({
            verdict: "INCONCLUSIVE",
            note: `Test broken: the checks could not run. ${checked.error}`,
          });
          continue;
        }
        const failures = scenario.checks.flatMap((check, index) => {
          const result = checked.result.results[index];
          return result?.ok === true
            ? []
            : [{ check: describeCheck(check), actual: result?.actual ?? "Not checked." }];
        });
        yield* record(
          failures.length === 0
            ? {
                verdict: "PASS",
                note: `All ${scenario.checks.length} checks held: ${scenario.checks.map(describeCheck).join("; ")}.`,
              }
            : {
                verdict: "FAIL",
                note: `${failures.length} of ${scenario.checks.length} checks failed on replay.`,
                expected: failures.map((failed) => failed.check).join("; "),
                actual: failures.map((failed) => failed.actual).join("; "),
              },
        );
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Regression replay stopped", { error, suiteId: suite.suiteId }),
      ),
      Effect.ensuring(
        Effect.gen(function* () {
          yield* recorder.finish(threadId, "regression").pipe(Effect.ignore({ log: true }));
          if (tabId !== undefined) yield* invoke("close", {}).pipe(Effect.ignore);
        }),
      ),
    );
    const finished = (yield* qaRuns.list(threadId)).find((entry) => entry.runId === run.runId);
    if (finished === undefined)
      return yield* new QaRunError({ message: "The regression run was deleted while it ran." });
    return finished;
  });

  const begin = Effect.fn("QaSuites.begin")(function* (input: QaSuiteRunInput) {
    const suite = yield* find(input.suiteId);
    const threadId = suite.sourceThreadId;
    if ((yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null))) === null)
      return yield* new QaRunError({
        message: "The thread this suite was saved from was deleted, so it cannot be replayed.",
      });
    if (yield* activity.active(threadId))
      return yield* new QaRunError({
        message: "An agent is working in this suite's thread. Replay it when the turn ends.",
      });
    if (input.baseUrl !== undefined && qaSiteOrigin(input.baseUrl) === null)
      return yield* new QaRunError({ message: "The base URL must be an http or https URL." });
    const steps = yield* prepareSteps(suite, input.baseUrl);
    const run = yield* qaRuns.startRegressionRun(threadId, {
      suiteId: suite.suiteId,
      site:
        suite.site === null ? null : rebaseUrl(suite.site, qaSiteOrigin(suite.site), input.baseUrl),
    });
    const fiber = yield* replay(suite, run, steps).pipe(Effect.forkIn(replays));
    return { suite, run, fiber };
  });

  return QaSuites.of({
    create,
    list: lock.withPermit(load()).pipe(Effect.map((suites) => suites.map(summaryOf))),
    subscribe: Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const snapshot = Effect.all({
          suites: lock.withPermit(load()).pipe(Effect.map((suites) => suites.map(summaryOf))),
          savedSecrets: savedSecrets.list,
        });
        return Stream.concat(
          Stream.fromEffect(snapshot),
          Stream.merge(Stream.fromSubscription(subscription), savedSecrets.changes).pipe(
            Stream.mapEffect(() => snapshot),
          ),
        );
      }),
    ),
    delete: deleteSuite,
    forgetSecret: savedSecrets.forget,
    start: Effect.fn("QaSuites.start")(function* (input) {
      const { run } = yield* begin(input);
      return { threadId: run.threadId, runId: run.runId };
    }),
    run: Effect.fn("QaSuites.run")(function* (input) {
      const { fiber } = yield* begin(input);
      return yield* Fiber.join(fiber);
    }),
  });
});

export const layer = Layer.effect(QaSuites, make);
