import {
  DEFAULT_QA_SUITE_VISUAL,
  INCOGNITO_BROWSER_PROFILE_ID,
  ProviderInstanceId,
  QaRunError,
  QaSuite,
  qaSiteOrigin,
  type PreviewAutomationCheckResult,
  type PreviewAutomationDurableTarget,
  type PreviewAutomationSnapshot,
  type PreviewAutomationStatus,
  type PreviewTabId,
  type QaDataRow,
  type QaHealProposal,
  type QaRegressionBatch,
  type QaRegressionJob,
  type QaReplayStep,
  type QaRun,
  type QaSavedSecretId,
  type QaSuiteAcceptBaselineInput,
  type QaSuiteCreateInput,
  type QaSuiteCreateResult,
  type QaSuiteId,
  type QaSuiteResolveProposalInput,
  type QaSuiteResolveProposalResult,
  type QaSuiteRunInput,
  type QaSuiteRunStarted,
  type QaSuiteScenario,
  type QaSuiteSummary,
  type QaSuitesSnapshot,
  type QaSuiteUpdateInput,
  type ThreadId,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
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
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { capturePage } from "./qaCapture.ts";
import * as QaRecorder from "./QaRecorder.ts";
import {
  applyParams,
  assertionFor,
  buildSuite,
  describeCheck,
  describeStep,
  fillSavedSecrets,
  editRefusal,
  fillSecrets,
  healPrompt,
  paramNames,
  rebaseUrl,
  savedSecretIds,
  stepTarget,
  withTarget,
} from "./qaReplay.ts";
import { describeVisual } from "./qaReport.ts";
import * as QaRuns from "./QaRuns.ts";
import * as QaSavedSecrets from "./QaSavedSecrets.ts";
import { compareScreenshots } from "./qaVisual.ts";

const STEP_TIMEOUT_MS = 15_000;
const CHECK_TIMEOUT_MS = 5_000;
const SETTLE_TIMEOUT_MS = 10_000;
const HEAL_RESOLVE_TIMEOUT_MS = 2_000;
/** Every replay draws at this size, so captures compare across runs and machines. */
const REPLAY_VIEWPORT = { width: 1280, height: 800 } as const;
const NO_PAGE = {
  url: null,
  title: null,
  png: null,
  consoleEntries: [],
  networkEntries: [],
  actionTimeline: [],
};
const KEPT_BATCHES = 10;

export interface QaRegressionResult {
  readonly batch: QaRegressionBatch;
  readonly runs: ReadonlyArray<QaRun>;
}

export class QaSuites extends Context.Service<
  QaSuites,
  {
    readonly create: (input: QaSuiteCreateInput) => Effect.Effect<QaSuiteCreateResult, QaRunError>;
    readonly get: (suiteId: QaSuiteId) => Effect.Effect<QaSuite, QaRunError>;
    readonly update: (input: QaSuiteUpdateInput) => Effect.Effect<QaSuite, QaRunError>;
    readonly list: Effect.Effect<ReadonlyArray<QaSuiteSummary>, QaRunError>;
    readonly subscribe: Stream.Stream<QaSuitesSnapshot, QaRunError>;
    readonly delete: (suiteId: QaSuiteId) => Effect.Effect<{ suiteId: QaSuiteId }, QaRunError>;
    /** Queues one replay per suite and data row, and returns at once. */
    readonly start: (input: QaSuiteRunInput) => Effect.Effect<QaSuiteRunStarted, QaRunError>;
    readonly forgetSecret: (secretId: QaSavedSecretId) => Effect.Effect<void, QaRunError>;
    /** Queues the replays and waits for every one of them. */
    readonly run: (input: QaSuiteRunInput) => Effect.Effect<QaRegressionResult, QaRunError>;
    /** Makes a replay's capture of one scenario the suite's new baseline. */
    readonly acceptBaseline: (input: QaSuiteAcceptBaselineInput) => Effect.Effect<void, QaRunError>;
    /** Applies or dismisses a healing proposal; applying reruns the suite with no AI. */
    readonly resolveProposal: (
      input: QaSuiteResolveProposalInput,
    ) => Effect.Effect<QaSuiteResolveProposalResult, QaRunError>;
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
  dataRowCount: suite.dataSet.rows.length,
  healingEnabled: suite.healing.enabled,
  proposals: suite.proposals,
});

const defaultName = (run: QaRun) => {
  const origin = run.site === null ? null : qaSiteOrigin(run.site);
  const host = origin === null ? "Regression" : new URL(origin).host;
  return `${host} · ${run.startedAt.slice(0, 10)}`;
};

const countsOf = (run: QaRun) => ({
  pass: run.scenarios.filter((scenario) => scenario.verdict === "PASS").length,
  fail: run.scenarios.filter((scenario) => scenario.verdict === "FAIL").length,
  inconclusive: run.scenarios.filter(
    (scenario) => scenario.verdict !== "PASS" && scenario.verdict !== "FAIL",
  ).length,
});

/** Why a suite's data set or parameters cannot be saved, or null. */
const dataSetRefusal = (suite: QaSuite): string | null => {
  const { columns, rows } = suite.dataSet;
  if (new Set(columns).size !== columns.length) return "Each data set column needs its own name.";
  if (rows.some((row) => row.length !== columns.length))
    return `Every data set row needs ${columns.length} values, one per column.`;
  const missing = paramNames(suite).filter((name) => !columns.includes(name));
  if (rows.length > 0 && missing.length > 0)
    return `The steps use {{param:${missing[0]}}}, but the data set has no "${missing[0]}" column.`;
  return null;
};

interface Job {
  readonly job: QaRegressionJob;
  readonly baseUrl: string | undefined;
  readonly heal: boolean;
  readonly done: Deferred.Deferred<QaRun | null>;
}

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
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const replays = yield* Effect.scope;
  const changes = yield* PubSub.unbounded<void>();
  const lock = yield* Semaphore.make(1);
  const queueLock = yield* Semaphore.make(1);
  const suitesDir = path.join(config.stateDir, "qa-suites");
  const suitePath = (suiteId: QaSuiteId) => path.join(suitesDir, `${suiteId}.json`);
  const baselineDir = (suiteId: QaSuiteId) => path.join(suitesDir, "baselines", suiteId);
  const baselinePath = (suiteId: QaSuiteId, scenarioIndex: number) =>
    path.join(baselineDir(suiteId), `${scenarioIndex}.png`);
  let cache: ReadonlyArray<QaSuite> | null = null;
  // Batches are a view of this server's queue; the runs they link to are what persists.
  let batches: Array<QaRegressionBatch> = [];
  const jobs = new Map<string, Job>();

  const nowIso = Clock.currentTimeMillis.pipe(
    Effect.map((millis) => DateTime.formatIso(DateTime.makeUnsafe(millis))),
  );
  const newId = (prefix: string) =>
    random.uuidV4().pipe(Effect.map((uuid) => `${prefix}-${uuid.slice(0, 13)}`));
  const publish = PubSub.publish(changes, undefined);

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

  /** Writes the suite, replacing the stored one with its id. */
  const save = Effect.fn("QaSuites.save")(function* (suite: QaSuite) {
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
        const others = existing.filter((entry) => entry.suiteId !== suite.suiteId);
        cache =
          existing.length === others.length
            ? [suite, ...others]
            : existing.map((entry) => (entry.suiteId === suite.suiteId ? suite : entry));
      }).pipe(Effect.mapError(failure("Could not save the regression suite."))),
    );
    yield* publish;
    return suite;
  });

  const create = Effect.fn("QaSuites.create")(function* (input: QaSuiteCreateInput) {
    const runs = yield* qaRuns.list(input.threadId);
    const run =
      input.runId === undefined
        ? runs.find((entry) => entry.kind !== "regression")
        : runs.find((entry) => entry.runId === input.runId);
    if (run === undefined)
      return yield* new QaRunError({
        message:
          input.runId === undefined
            ? "This thread has no QA test run to save."
            : "That QA run no longer exists.",
      });
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
    const shell = yield* threads
      .getThreadShell(run.threadId)
      .pipe(Effect.orElseSucceed(() => null));
    const suite = yield* save({
      suiteId: yield* newId("suite"),
      name: input.name ?? defaultName(run),
      createdAt: yield* nowIso,
      projectId: run.projectId,
      sourceThreadId: run.threadId,
      sourceRunId: run.runId,
      site: run.site,
      steps: [...built.steps],
      scenarios: [...built.scenarios],
      visual: DEFAULT_QA_SUITE_VISUAL,
      dataSet: { columns: [], rows: [] },
      healing: { enabled: false, modelSelection: null },
      recordedWith: shell?.modelSelection ?? null,
      proposals: [],
    });
    return { suite: summaryOf(suite), skipped: built.skipped };
  });

  const update = Effect.fn("QaSuites.update")(function* (input: QaSuiteUpdateInput) {
    const suite = yield* find(input.suiteId);
    const steps = input.steps ?? suite.steps;
    const scenarios = input.scenarios ?? suite.scenarios;
    const refused = editRefusal(suite, { steps, scenarios });
    if (refused !== null) return yield* new QaRunError({ message: refused });
    const next: QaSuite = {
      ...suite,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.visual === undefined ? {} : { visual: input.visual }),
      ...(input.dataSet === undefined ? {} : { dataSet: input.dataSet }),
      ...(input.healing === undefined ? {} : { healing: input.healing }),
      steps,
      scenarios,
    };
    const dataRefused = dataSetRefusal(next);
    if (dataRefused !== null) return yield* new QaRunError({ message: dataRefused });
    return yield* save(next);
  });

  const deleteSuite = Effect.fn("QaSuites.delete")(function* (suiteId: QaSuiteId) {
    yield* find(suiteId);
    yield* lock.withPermit(
      fileSystem.remove(suitePath(suiteId)).pipe(
        Effect.andThen(
          fileSystem.remove(baselineDir(suiteId), { recursive: true }).pipe(Effect.ignore),
        ),
        Effect.tap(() =>
          Effect.sync(() => {
            cache = cache?.filter((suite) => suite.suiteId !== suiteId) ?? null;
          }),
        ),
        Effect.mapError(failure("Could not delete the regression suite.")),
      ),
    );
    yield* publish;
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

  /**
   * The suite as one replay runs it: a data row's values in its parameters, the thread's
   * passwords in its secrets, and its origin moved to `baseUrl`.
   */
  const prepare = Effect.fn("QaSuites.prepare")(function* (
    suite: QaSuite,
    dataRow: QaDataRow | null,
    baseUrl: string | undefined,
  ) {
    const withParams = applyParams(suite, dataRow?.values ?? {});
    if ("missing" in withParams)
      return yield* new QaRunError({
        message:
          dataRow === null
            ? `The suite uses {{param:${withParams.missing}}}. Add a data set with that column first.`
            : `Data row ${dataRow.index + 1} has no value for {{param:${withParams.missing}}}.`,
      });
    const secrets = yield* threadProvidedSecretsInOrder(threads, suite.sourceThreadId).pipe(
      Effect.mapError(failure("Could not read the suite's thread.")),
    );
    const origin = suite.site === null ? null : qaSiteOrigin(suite.site);
    const steps: Array<QaReplayStep> = [];
    for (const step of withParams.steps) {
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
    return { steps, scenarios: withParams.scenarios, unfilled: withParams.steps };
  });

  const readBaseline = (suiteId: QaSuiteId, index: number) =>
    fileSystem.readFile(baselinePath(suiteId, index)).pipe(Effect.orElseSucceed(() => null));

  const writeBaseline = (suiteId: QaSuiteId, index: number, png: Uint8Array) =>
    fileSystem
      .makeDirectory(baselineDir(suiteId), { recursive: true })
      .pipe(
        Effect.andThen(fileSystem.writeFile(baselinePath(suiteId, index), png)),
        Effect.mapError(failure("Could not save the baseline screenshot.")),
      );

  const replay = Effect.fn("QaSuites.replay")(function* (
    suite: QaSuite,
    run: QaRun,
    prepared: {
      readonly steps: ReadonlyArray<QaReplayStep>;
      readonly scenarios: ReadonlyArray<QaSuiteScenario>;
      readonly unfilled: ReadonlyArray<QaReplayStep>;
    },
    heal: boolean,
  ) {
    const threadId = suite.sourceThreadId;
    const { steps, scenarios } = prepared;
    // Typed text is described as saved, so reports show placeholders, never the filled passwords.
    const described = steps.map((step, index) =>
      describeStep(step.kind === "type" ? (prepared.unfilled[index] ?? step) : step),
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
    const settleAndCheck = (
      assertions: ReadonlyArray<ReturnType<typeof assertionFor>>,
      capture = false,
    ) =>
      invoke<PreviewAutomationCheckResult>(
        "check",
        {
          assertions,
          settle: true,
          timeoutMs: CHECK_TIMEOUT_MS,
          ...(capture ? { capture: { masks: suite.visual.masks } } : {}),
        },
        SETTLE_TIMEOUT_MS + (assertions.length + 1) * CHECK_TIMEOUT_MS + 5_000,
      );

    /** Asks the suite's model for the step's element in the page as it is; never acts on it. */
    const proposeFix = Effect.fn("QaSuites.proposeFix")(function* (stepIndex: number) {
      const step = steps[stepIndex];
      const before = step === undefined ? null : stepTarget(step);
      const modelSelection = suite.healing.modelSelection ?? suite.recordedWith;
      if (step === undefined || before === null) return null;
      if (modelSelection === null)
        return "Healing needs a model; choose one in the suite's settings.";
      const snapshot = yield* invoke<PreviewAutomationSnapshot>("snapshot", {
        pixelsRequired: false,
      });
      const answer = yield* textGeneration.generateLocatorHeal({
        cwd: config.cwd,
        prompt: healPrompt(step, String(snapshot.accessibilityTree)),
        modelSelection,
        projectId: suite.projectId,
      });
      if (answer.ref === null) return "Healing found no element that clearly matches.";
      const resolved = yield* invoke<{ readonly recordedTarget?: PreviewAutomationDurableTarget }>(
        "waitFor",
        {
          locator: `aria-ref=${answer.ref.replace(/^aria-ref=/, "")}`,
          timeoutMs: HEAL_RESOLVE_TIMEOUT_MS,
        },
      );
      const after = resolved.recordedTarget;
      if (after === undefined || after.selector === before.selector)
        return "Healing found no element it could name differently.";
      const proposal: QaHealProposal = {
        stepIndex,
        before,
        after,
        runId: run.runId,
        proposedAt: yield* nowIso,
      };
      const current = yield* find(suite.suiteId);
      yield* save({
        ...current,
        proposals: [
          ...current.proposals.filter((entry) => entry.stepIndex !== stepIndex),
          proposal,
        ],
      });
      return `Healing proposes ${after.display} instead of ${before.display}. Accept or dismiss it under Regression suites; nothing changes until you do.`;
    });

    let recorded = 0;
    yield* Effect.gen(function* () {
      // A fresh incognito tab: no cookies or logins from earlier runs change what the steps do.
      const opened = yield* invoke<PreviewAutomationStatus>("open", {
        reuseExistingTab: false,
        profileId: INCOGNITO_BROWSER_PROFILE_ID,
      });
      tabId = opened.tabId ?? undefined;
      yield* invoke("resize", { mode: "freeform", ...REPLAY_VIEWPORT }).pipe(Effect.ignore);
      if (tabId !== undefined) yield* recorder.startVideo(scope, tabId);

      let next = 0;
      let broken: string | null = null;
      for (const [scenarioIndex, scenario] of scenarios.entries()) {
        const stepsText = described.slice(next, scenario.stepCount).slice(-30);
        const record = (input: {
          readonly verdict: "PASS" | "FAIL" | "INCONCLUSIVE";
          readonly note: string;
          readonly expected?: string;
          readonly actual?: string;
          readonly visual?: QaRuns.QaReplayVisual;
        }) => {
          const { visual, ...evidence } = input;
          return capturePage(broker, scope, tabId).pipe(
            Effect.orElseSucceed(() => NO_PAGE),
            Effect.flatMap((page) =>
              qaRuns.recordReplayedScenario(
                threadId,
                {
                  scenario: scenario.scenario.slice(0, 200),
                  steps: stepsText,
                  ...evidence,
                  ...(input.verdict === "FAIL" ? { severity: "major" as const } : {}),
                },
                page,
                { checks: scenario.checks, stepCount: scenario.stepCount, visual },
              ),
            ),
            Effect.tap(() =>
              Effect.sync(() => {
                recorded += 1;
              }),
            ),
          );
        };
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
            const healed =
              heal && suite.healing.enabled && step !== undefined && stepTarget(step) !== null
                ? yield* proposeFix(next).pipe(
                    Effect.catch((error) =>
                      Effect.succeed(`Healing failed: ${errorMessage(error)}`),
                    ),
                  )
                : null;
            yield* record({
              verdict: "INCONCLUSIVE",
              note: `Test broken: ${named} could not run. ${failed} The page may have changed; this is not a product verdict.${healed === null ? "" : ` ${healed}`}`,
            });
            break;
          }
        }
        if (broken !== null) continue;
        const assertions = scenario.checks.map(assertionFor);
        const checked = yield* settleAndCheck(assertions, true).pipe(
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
        const visual = yield* compareVisual(suite, scenarioIndex, checked.result.capture);
        const looksDifferent =
          visual !== undefined && visual.diffRatio !== null && visual.diffRatio > visual.threshold;
        const visualNote =
          visual === undefined
            ? ""
            : ` ${describeVisual({ ...visual, baselinePath: "", capturePath: "", diffPath: null })}`;
        yield* record(
          failures.length === 0 && !looksDifferent
            ? {
                verdict: "PASS",
                note: `All ${scenario.checks.length} checks held: ${scenario.checks.map(describeCheck).join("; ")}.${visualNote}`,
                ...(visual === undefined ? {} : { visual }),
              }
            : {
                verdict: "FAIL",
                note:
                  failures.length === 0
                    ? `FAIL (visual): the checks held, but the page looks different.${visualNote}`
                    : `${failures.length} of ${scenario.checks.length} checks failed on replay.${visualNote}`,
                expected: [
                  ...failures.map((failed) => failed.check),
                  ...(looksDifferent ? ["looks like the baseline"] : []),
                ].join("; "),
                actual: [
                  ...failures.map((failed) => failed.actual),
                  ...(looksDifferent && visual?.diffRatio != null
                    ? [`${(visual.diffRatio * 100).toFixed(2)}% of pixels differ`]
                    : []),
                ].join("; "),
                ...(visual === undefined ? {} : { visual }),
              },
        );
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("Regression replay stopped", { error, suiteId: suite.suiteId });
          // An empty run would read as a pass, so every scenario left says why it never ran.
          for (const scenario of scenarios.slice(recorded)) {
            yield* qaRuns
              .recordReplayedScenario(
                threadId,
                {
                  scenario: scenario.scenario.slice(0, 200),
                  steps: [],
                  verdict: "INCONCLUSIVE",
                  note: `Not run: the replay stopped. ${errorMessage(error)} This is not a product verdict.`,
                },
                NO_PAGE,
                { checks: scenario.checks, stepCount: scenario.stepCount },
              )
              .pipe(Effect.ignore({ log: true }));
          }
        }),
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

  /** The capture compared with the scenario's baseline; the first capture becomes the baseline. */
  const compareVisual = Effect.fn("QaSuites.compareVisual")(function* (
    suite: QaSuite,
    scenarioIndex: number,
    captureBase64: string | undefined,
  ) {
    if (captureBase64 === undefined) return undefined;
    const capture = Uint8Array.from(Buffer.from(captureBase64, "base64"));
    const baseline = yield* readBaseline(suite.suiteId, scenarioIndex);
    if (baseline === null) {
      yield* writeBaseline(suite.suiteId, scenarioIndex, capture).pipe(
        Effect.ignore({ log: true }),
      );
      return {
        baseline: capture,
        capture,
        diffPng: null,
        diffRatio: null,
        threshold: suite.visual.threshold,
      } satisfies QaRuns.QaReplayVisual;
    }
    const compared = yield* Effect.try({
      try: () => compareScreenshots(baseline, capture),
      catch: failure("Could not compare the screenshots."),
    }).pipe(Effect.option);
    if (compared._tag === "None") return undefined;
    return {
      baseline,
      capture,
      diffPng: compared.value.diffPng,
      diffRatio: compared.value.diffRatio,
      threshold: suite.visual.threshold,
    } satisfies QaRuns.QaReplayVisual;
  });

  const updateJob = Effect.fn("QaSuites.updateJob")(function* (
    jobId: string,
    patch: Partial<QaRegressionJob>,
  ) {
    const entry = jobs.get(jobId);
    if (entry === undefined) return;
    const job = { ...entry.job, ...patch };
    jobs.set(jobId, { ...entry, job });
    batches = batches.map((batch) => ({
      ...batch,
      jobs: batch.jobs.map((existing) => (existing.jobId === jobId ? job : existing)),
    }));
    yield* publish;
  });

  /** Runs one queued replay to its end; a replay that cannot start fails its job, not the queue. */
  const execute = Effect.fn("QaSuites.execute")(function* (entry: Job) {
    const { job } = entry;
    const outcome = yield* Effect.gen(function* () {
      const suite = yield* find(job.suiteId);
      const threadId = suite.sourceThreadId;
      if ((yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null))) === null)
        return yield* new QaRunError({
          message: "The thread this suite was saved from was deleted, so it cannot be replayed.",
        });
      if (yield* activity.active(threadId))
        return yield* new QaRunError({
          message: "An agent is working in this suite's thread. Replay it when the turn ends.",
        });
      const prepared = yield* prepare(suite, job.dataRow, entry.baseUrl);
      const run = yield* qaRuns.startRegressionRun(threadId, {
        suiteId: suite.suiteId,
        site:
          suite.site === null
            ? null
            : rebaseUrl(suite.site, qaSiteOrigin(suite.site), entry.baseUrl),
        dataRow: job.dataRow,
      });
      yield* updateJob(job.jobId, { runId: run.runId });
      return yield* replay(suite, run, prepared, entry.heal);
    }).pipe(Effect.result);
    if (outcome._tag === "Success") {
      yield* updateJob(job.jobId, { status: "done", counts: countsOf(outcome.success) });
      yield* Deferred.succeed(entry.done, outcome.success);
    } else {
      yield* updateJob(job.jobId, { status: "failed", error: outcome.failure.message });
      yield* Deferred.succeed(entry.done, null);
    }
    yield* pump;
  });

  /** Starts queued replays up to the parallel limit, one at a time per thread. */
  const pump: Effect.Effect<void> = Effect.suspend(() =>
    queueLock.withPermit(
      Effect.gen(function* () {
        const limit = yield* serverSettings.getSettings.pipe(
          Effect.map((settings) => settings.qaRegressionParallelRuns),
          Effect.orElseSucceed(() => 2),
        );
        const all = [...jobs.values()].map((entry) => entry.job);
        const running = all.filter((job) => job.status === "running");
        const busyThreads = new Set(running.map((job) => job.threadId));
        let slots = limit - running.length;
        for (const job of all) {
          if (slots <= 0) break;
          if (job.status !== "queued" || busyThreads.has(job.threadId)) continue;
          slots -= 1;
          busyThreads.add(job.threadId);
          yield* updateJob(job.jobId, { status: "running" });
          yield* execute(jobs.get(job.jobId)!).pipe(Effect.forkIn(replays));
        }
      }),
    ),
  );

  const enqueue = Effect.fn("QaSuites.enqueue")(function* (input: QaSuiteRunInput) {
    if (input.baseUrl !== undefined && qaSiteOrigin(input.baseUrl) === null)
      return yield* new QaRunError({ message: "The base URL must be an http or https URL." });
    const suites: Array<QaSuite> = [];
    for (const suiteId of new Set(input.suiteIds)) suites.push(yield* find(suiteId));
    const batchJobs: Array<Job> = [];
    for (const suite of suites) {
      const columns = suite.dataSet.columns;
      const rows: ReadonlyArray<QaDataRow | null> =
        suite.dataSet.rows.length === 0
          ? [null]
          : suite.dataSet.rows.map((values, index) => ({
              index,
              values: Object.fromEntries(
                columns.map((name, column) => [name, values[column] ?? ""]),
              ),
            }));
      for (const dataRow of rows) {
        batchJobs.push({
          job: {
            jobId: yield* newId("job"),
            suiteId: suite.suiteId,
            suiteName: suite.name,
            threadId: suite.sourceThreadId,
            dataRow,
            status: "queued",
            runId: null,
            counts: null,
            error: null,
          },
          baseUrl: input.baseUrl,
          heal: input.heal !== false,
          done: yield* Deferred.make<QaRun | null>(),
        });
      }
    }
    const projects = new Set(suites.map((suite) => suite.projectId));
    const batch: QaRegressionBatch = {
      batchId: yield* newId("batch"),
      createdAt: yield* nowIso,
      label: input.label ?? (suites.length === 1 ? suites[0]!.name : `${suites.length} suites`),
      projectId: projects.size === 1 ? [...projects][0]! : null,
      jobs: batchJobs.map((entry) => entry.job),
    };
    yield* queueLock.withPermit(
      Effect.sync(() => {
        for (const entry of batchJobs) jobs.set(entry.job.jobId, entry);
        const kept = [batch, ...batches];
        const dropped = kept.slice(KEPT_BATCHES);
        batches = kept.slice(0, KEPT_BATCHES);
        // A dropped batch's queued jobs still run; only finished ones are forgotten.
        for (const old of dropped)
          for (const job of old.jobs)
            if (job.status === "done" || job.status === "failed") jobs.delete(job.jobId);
      }),
    );
    yield* publish;
    yield* pump;
    return { batch, entries: batchJobs };
  });

  const acceptBaseline = Effect.fn("QaSuites.acceptBaseline")(function* (
    input: QaSuiteAcceptBaselineInput,
  ) {
    const suite = yield* find(input.suiteId);
    const run = (yield* qaRuns.list(input.threadId)).find((entry) => entry.runId === input.runId);
    const visual = run?.scenarios[input.scenarioIndex]?.visual;
    if (run === undefined || run.suiteId !== suite.suiteId || visual == null)
      return yield* new QaRunError({ message: "That replay has no capture to use as a baseline." });
    const capture = yield* fileSystem
      .readFile(visual.capturePath)
      .pipe(Effect.mapError(failure("The replay's capture is gone.")));
    yield* writeBaseline(suite.suiteId, input.scenarioIndex, capture);
  });

  const resolveProposal = Effect.fn("QaSuites.resolveProposal")(function* (
    input: QaSuiteResolveProposalInput,
  ) {
    const suite = yield* find(input.suiteId);
    const proposal = suite.proposals.find((entry) => entry.stepIndex === input.stepIndex);
    const step = suite.steps[input.stepIndex];
    if (proposal === undefined || step === undefined)
      return yield* new QaRunError({ message: "That fix is no longer proposed." });
    const proposals = suite.proposals.filter((entry) => entry !== proposal);
    if (!input.accept) {
      yield* save({ ...suite, proposals });
      return { batchId: null };
    }
    const steps = suite.steps.map((entry, index) =>
      index === input.stepIndex ? withTarget(entry, proposal.after) : entry,
    );
    yield* save({ ...suite, steps, proposals });
    const { batch } = yield* enqueue({
      suiteIds: [suite.suiteId],
      heal: false,
      label: `${suite.name} · fix accepted`,
    });
    return { batchId: batch.batchId };
  });

  const snapshot = Effect.all({
    suites: lock.withPermit(load()).pipe(Effect.map((suites) => suites.map(summaryOf))),
    savedSecrets: savedSecrets.list,
  }).pipe(Effect.map((parts) => ({ ...parts, batches })));

  return QaSuites.of({
    create,
    get: find,
    update,
    list: lock.withPermit(load()).pipe(Effect.map((suites) => suites.map(summaryOf))),
    subscribe: Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
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
      const { batch } = yield* enqueue(input);
      return { batchId: batch.batchId };
    }),
    run: Effect.fn("QaSuites.run")(function* (input) {
      const { batch, entries } = yield* enqueue(input);
      const runs: Array<QaRun> = [];
      for (const entry of entries) {
        const run = yield* Deferred.await(entry.done);
        if (run !== null) runs.push(run);
      }
      return { batch: batches.find((entry) => entry.batchId === batch.batchId) ?? batch, runs };
    }),
    acceptBaseline,
    resolveProposal,
  });
});

export const layer = Layer.effect(QaSuites, make);
