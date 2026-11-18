import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { PreviewAutomationAssertion, PreviewAutomationDurableTarget } from "./previewAutomation.ts";

export const QA_VERDICTS = ["PASS", "FAIL", "BLOCKED", "INCONCLUSIVE", "SKIPPED"] as const;
export const QaVerdict = Schema.Literals(QA_VERDICTS);
export type QaVerdict = typeof QaVerdict.Type;

export const QaBugSeverity = Schema.Literals(["critical", "major", "minor", "trivial"]);
export type QaBugSeverity = typeof QaBugSeverity.Type;

export const QaRunId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z0-9-]+$/),
);
export type QaRunId = typeof QaRunId.Type;

/** A site a QA project tests, stored as its origin (`https://shop.test`). */
export const QaSiteOrigin = TrimmedNonEmptyString.check(
  Schema.isMaxLength(2048),
  Schema.isPattern(/^https?:\/\/[^/?#\s]+$/),
);
export const QaSiteOrigins = Schema.Array(QaSiteOrigin).check(Schema.isMaxLength(20));
export type QaSiteOrigins = typeof QaSiteOrigins.Type;

/** The origin of an http(s) URL, or null for anything else. */
export function qaSiteOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

const QaText = (max: number) => Schema.String.check(Schema.isMaxLength(max));

/** What the agent reports for one scenario; the server adds the evidence. */
export const QaEvidenceRecordInput = Schema.Struct({
  scenario: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  verdict: QaVerdict,
  note: QaText(4000),
  expected: Schema.optional(QaText(2000)),
  actual: Schema.optional(QaText(2000)),
  severity: Schema.optional(QaBugSeverity),
  steps: Schema.optional(Schema.Array(QaText(500)).check(Schema.isMaxLength(30))),
  /** What proves the verdict, checked against the live page before it is saved. */
  checks: Schema.optional(Schema.Array(PreviewAutomationAssertion).check(Schema.isMaxLength(10))),
});
export type QaEvidenceRecordInput = typeof QaEvidenceRecordInput.Type;

export const QaFailedRequest = Schema.Struct({
  method: Schema.String,
  url: Schema.String,
  status: Schema.NullOr(Schema.Number),
  errorText: Schema.optional(Schema.String),
});
export type QaFailedRequest = typeof QaFailedRequest.Type;

/** One browser action a regression replays, targeted so it survives navigation. */
const Target = PreviewAutomationDurableTarget;
const Modifiers = Schema.Array(Schema.Literals(["Alt", "Control", "Meta", "Shift"]));
export const QaReplayStep = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("navigate"), url: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("click"),
    target: Target,
    button: Schema.optional(Schema.Literals(["left", "right", "middle"])),
    clickCount: Schema.optional(Schema.Int),
  }),
  Schema.Struct({ kind: Schema.Literal("clickAt"), x: Schema.Finite, y: Schema.Finite }),
  Schema.Struct({
    kind: Schema.Literal("type"),
    target: Schema.NullOr(Target),
    /** `{{secret:N}}` is the Nth password given in the thread; `{{saved:<id>}}` a remembered one. */
    text: Schema.String,
    clear: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ kind: Schema.Literal("hover"), target: Target }),
  Schema.Struct({
    kind: Schema.Literal("select"),
    target: Target,
    values: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("press"),
    key: Schema.String,
    modifiers: Schema.optional(Modifiers),
  }),
  Schema.Struct({
    kind: Schema.Literal("scroll"),
    target: Schema.NullOr(Target),
    deltaX: Schema.optional(Schema.Finite),
    deltaY: Schema.optional(Schema.Finite),
  }),
  Schema.Struct({
    kind: Schema.Literal("waitFor"),
    target: Schema.NullOr(Target),
    text: Schema.optional(Schema.String),
    urlIncludes: Schema.optional(Schema.String),
  }),
  /** An action the replay cannot repeat; scenarios after it cannot be saved. */
  Schema.Struct({
    kind: Schema.Literal("unreplayable"),
    action: Schema.String,
    reason: Schema.String,
  }),
]);
export type QaReplayStep = typeof QaReplayStep.Type;

/** A check that held on the live page when the agent recorded its verdict. */
export const QaCheck = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("textVisible"), text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("urlIncludes"), value: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("elementVisible"), target: Target }),
  Schema.Struct({ kind: Schema.Literal("valueEquals"), target: Target, value: Schema.String }),
]);
export type QaCheck = typeof QaCheck.Type;

export const QaVisualResult = Schema.Struct({
  /** Share of pixels that differ from the baseline, 0 to 1; null when the baseline was just saved. */
  diffRatio: Schema.NullOr(Schema.Finite),
  threshold: Schema.Finite,
  baselinePath: Schema.String,
  /** The masked, fixed-viewport capture compared with the baseline. */
  capturePath: Schema.String,
  diffPath: Schema.NullOr(Schema.String),
});
export type QaVisualResult = typeof QaVisualResult.Type;

export const QaScenario = Schema.Struct({
  index: NonNegativeInt,
  scenario: Schema.String,
  verdict: QaVerdict,
  /** Set when the server downgraded the agent's verdict, for example for missing evidence. */
  requestedVerdict: Schema.optional(QaVerdict),
  downgradeReason: Schema.optional(Schema.String),
  note: Schema.String,
  expected: Schema.optional(Schema.String),
  actual: Schema.optional(Schema.String),
  severity: Schema.optional(QaBugSeverity),
  steps: Schema.Array(Schema.String),
  pageUrl: Schema.NullOr(Schema.String),
  pageTitle: Schema.NullOr(Schema.String),
  recordedAt: Schema.String,
  /** Where this scenario starts in the run's video, when one was recording. */
  videoOffsetMs: Schema.NullOr(NonNegativeInt),
  screenshotPath: Schema.NullOr(Schema.String),
  consolePath: Schema.NullOr(Schema.String),
  networkPath: Schema.NullOr(Schema.String),
  consoleErrorCount: NonNegativeInt,
  failedRequestCount: NonNegativeInt,
  /** The first few, so the panel can show them without reading the log files. */
  consoleErrors: Schema.Array(Schema.String),
  failedRequests: Schema.Array(QaFailedRequest),
  checks: Schema.Array(QaCheck).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** How many browser steps the run had taken when this verdict was recorded. */
  stepCount: Schema.NullOr(NonNegativeInt).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** A replay's visual comparison with the suite's baseline for this scenario. */
  visual: Schema.NullOr(QaVisualResult).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type QaScenario = typeof QaScenario.Type;

export const QaRunVideo = Schema.Struct({
  path: Schema.String,
  sizeBytes: NonNegativeInt,
});
export type QaRunVideo = typeof QaRunVideo.Type;

export const QaSuiteId = QaRunId;
export type QaSuiteId = typeof QaSuiteId.Type;

export const QaDataRow = Schema.Struct({
  index: NonNegativeInt,
  values: Schema.Record(Schema.String, Schema.String),
});
export type QaDataRow = typeof QaDataRow.Type;

export const QaRun = Schema.Struct({
  runId: QaRunId,
  threadId: ThreadId,
  /** A regression run replays a saved suite without a model. */
  kind: Schema.Literals(["exploratory", "regression"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("exploratory" as const)),
  ),
  suiteId: Schema.NullOr(QaSuiteId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** The data set row a regression run replayed with, by its 0-based index. */
  dataRow: Schema.NullOr(QaDataRow).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Null for threads without a project; set when the run finishes, since a thread can move. */
  projectId: Schema.NullOr(ProjectId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  site: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  dir: Schema.String,
  scenarios: Schema.Array(QaScenario),
  recordingStartedAt: Schema.NullOr(Schema.String),
  video: Schema.NullOr(QaRunVideo),
  /** Why there is no video, so a report never leaves it out silently. */
  videoUnavailableReason: Schema.NullOr(Schema.String),
  reportMarkdownPath: Schema.NullOr(Schema.String),
  reportHtmlPath: Schema.NullOr(Schema.String),
});
export type QaRun = typeof QaRun.Type;

export const QaRunsSubscribeInput = Schema.Struct({ threadId: ThreadId });
export type QaRunsSubscribeInput = typeof QaRunsSubscribeInput.Type;

/** Newest run first. */
export const MemoryBriefUsage = Schema.Struct({
  characters: NonNegativeInt,
  estimatedTokens: NonNegativeInt,
});
export type MemoryBriefUsage = typeof MemoryBriefUsage.Type;
export const QaRunsSnapshot = Schema.Struct({
  runs: Schema.Array(QaRun),
  memoryBriefUsage: Schema.NullOr(MemoryBriefUsage).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type QaRunsSnapshot = typeof QaRunsSnapshot.Type;

export const QaRunDeleteInput = Schema.Struct({ threadId: ThreadId, runId: QaRunId });
export type QaRunDeleteInput = typeof QaRunDeleteInput.Type;

export const QaRunDeleteResult = Schema.Struct({ runId: QaRunId });
export type QaRunDeleteResult = typeof QaRunDeleteResult.Type;

export const QaSuiteScenario = Schema.Struct({
  scenario: Schema.String,
  stepCount: NonNegativeInt,
  checks: Schema.Array(QaCheck),
});
export type QaSuiteScenario = typeof QaSuiteScenario.Type;

/** How a replay compares each scenario's look with its baseline. */
export const QaSuiteVisual = Schema.Struct({
  /** Share of pixels allowed to differ before the scenario fails, 0 to 1. */
  threshold: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  /** Selectors for content that changes every run, such as clocks; hidden in both captures. */
  masks: Schema.Array(QaText(500)).check(Schema.isMaxLength(20)),
});
export type QaSuiteVisual = typeof QaSuiteVisual.Type;
export const DEFAULT_QA_SUITE_VISUAL: QaSuiteVisual = { threshold: 0.01, masks: [] };

export const QaParamName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,40}$/));

/** Rows of parameters; each row is one replay, and `{{param:name}}` reads its column. */
export const QaDataSet = Schema.Struct({
  columns: Schema.Array(QaParamName).check(Schema.isMaxLength(20)),
  rows: Schema.Array(Schema.Array(QaText(2000))).check(Schema.isMaxLength(100)),
});
export type QaDataSet = typeof QaDataSet.Type;

export const QaSuiteHealing = Schema.Struct({
  enabled: Schema.Boolean,
  /** Null uses the provider and model the suite was recorded with. */
  modelSelection: Schema.NullOr(ModelSelection),
});
export type QaSuiteHealing = typeof QaSuiteHealing.Type;

/** A new target a healing turn found for a step whose element was gone; the user decides. */
export const QaHealProposal = Schema.Struct({
  stepIndex: NonNegativeInt,
  before: PreviewAutomationDurableTarget,
  after: PreviewAutomationDurableTarget,
  runId: QaRunId,
  proposedAt: Schema.String,
});
export type QaHealProposal = typeof QaHealProposal.Type;

/** A passed run saved so it can be replayed without a model. */
export const QaSuite = Schema.Struct({
  suiteId: QaSuiteId,
  name: TrimmedNonEmptyString,
  createdAt: Schema.String,
  projectId: Schema.NullOr(ProjectId),
  /** Replays run in this thread, and its passwords fill `{{secret:N}}`. */
  sourceThreadId: ThreadId,
  sourceRunId: QaRunId,
  site: Schema.NullOr(Schema.String),
  steps: Schema.Array(QaReplayStep),
  scenarios: Schema.Array(QaSuiteScenario),
  visual: QaSuiteVisual.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_QA_SUITE_VISUAL))),
  dataSet: QaDataSet.pipe(Schema.withDecodingDefault(Effect.succeed({ columns: [], rows: [] }))),
  healing: QaSuiteHealing.pipe(
    Schema.withDecodingDefault(Effect.succeed({ enabled: false, modelSelection: null })),
  ),
  recordedWith: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  proposals: Schema.Array(QaHealProposal).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type QaSuite = typeof QaSuite.Type;

export const QaSuiteSummary = Schema.Struct({
  suiteId: QaSuiteId,
  name: Schema.String,
  createdAt: Schema.String,
  projectId: Schema.NullOr(ProjectId),
  sourceThreadId: ThreadId,
  site: Schema.NullOr(Schema.String),
  scenarioCount: NonNegativeInt,
  stepCount: NonNegativeInt,
  dataRowCount: NonNegativeInt,
  healingEnabled: Schema.Boolean,
  proposals: Schema.Array(QaHealProposal),
});
export type QaSuiteSummary = typeof QaSuiteSummary.Type;

export const QaSavedSecretId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^qa-secret-[0-9a-f]+$/),
);
export type QaSavedSecretId = typeof QaSavedSecretId.Type;

/** A password the user chose to remember for a project's suites; the value stays on the server. */
export const QaSavedSecret = Schema.Struct({
  secretId: QaSavedSecretId,
  projectId: ProjectId,
  label: Schema.String,
  /** The sign-in page's origin, or null when the card named none. */
  site: Schema.NullOr(Schema.String),
  savedAt: Schema.String,
});
export type QaSavedSecret = typeof QaSavedSecret.Type;

export const QaVerdictCounts = Schema.Struct({
  pass: NonNegativeInt,
  fail: NonNegativeInt,
  inconclusive: NonNegativeInt,
});
export type QaVerdictCounts = typeof QaVerdictCounts.Type;

/** One replay in a batch: a suite, with one data row when the suite has a data set. */
export const QaRegressionJob = Schema.Struct({
  jobId: Schema.String,
  suiteId: QaSuiteId,
  suiteName: Schema.String,
  threadId: ThreadId,
  dataRow: Schema.NullOr(QaDataRow),
  status: Schema.Literals(["queued", "running", "done", "failed"]),
  runId: Schema.NullOr(QaRunId),
  counts: Schema.NullOr(QaVerdictCounts),
  /** Why the replay could not start. */
  error: Schema.NullOr(Schema.String),
});
export type QaRegressionJob = typeof QaRegressionJob.Type;

export const QaRegressionBatch = Schema.Struct({
  batchId: Schema.String,
  createdAt: Schema.String,
  label: Schema.String,
  projectId: Schema.NullOr(ProjectId),
  jobs: Schema.Array(QaRegressionJob),
});
export type QaRegressionBatch = typeof QaRegressionBatch.Type;

export const QaSuitesSnapshot = Schema.Struct({
  suites: Schema.Array(QaSuiteSummary),
  savedSecrets: Schema.Array(QaSavedSecret).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Recent batches since the server started, newest first. */
  batches: Schema.Array(QaRegressionBatch).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type QaSuitesSnapshot = typeof QaSuitesSnapshot.Type;

export const QaSuiteCreateInput = Schema.Struct({
  threadId: ThreadId,
  runId: QaRunId,
  name: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
});
export type QaSuiteCreateInput = typeof QaSuiteCreateInput.Type;

/** A scenario of the run the suite left out, and why. */
export const QaSuiteSkippedScenario = Schema.Struct({
  scenario: Schema.String,
  reason: Schema.String,
});
export type QaSuiteSkippedScenario = typeof QaSuiteSkippedScenario.Type;

export const QaSuiteCreateResult = Schema.Struct({
  suite: QaSuiteSummary,
  skipped: Schema.Array(QaSuiteSkippedScenario),
});
export type QaSuiteCreateResult = typeof QaSuiteCreateResult.Type;

export const QaSuiteDeleteInput = Schema.Struct({ suiteId: QaSuiteId });
export type QaSuiteDeleteInput = typeof QaSuiteDeleteInput.Type;
export const QaSuiteDeleteResult = Schema.Struct({ suiteId: QaSuiteId });
export type QaSuiteDeleteResult = typeof QaSuiteDeleteResult.Type;

export const QaSavedSecretForgetInput = Schema.Struct({ secretId: QaSavedSecretId });
export type QaSavedSecretForgetInput = typeof QaSavedSecretForgetInput.Type;

export const QaSuiteGetInput = Schema.Struct({ suiteId: QaSuiteId });
export type QaSuiteGetInput = typeof QaSuiteGetInput.Type;

/** Changes to a suite. Edited steps and checks may change only their text, never their shape. */
export const QaSuiteUpdateInput = Schema.Struct({
  suiteId: QaSuiteId,
  name: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  visual: Schema.optional(QaSuiteVisual),
  dataSet: Schema.optional(QaDataSet),
  healing: Schema.optional(QaSuiteHealing),
  steps: Schema.optional(Schema.Array(QaReplayStep)),
  scenarios: Schema.optional(Schema.Array(QaSuiteScenario)),
});
export type QaSuiteUpdateInput = typeof QaSuiteUpdateInput.Type;

export const QaSuiteRunInput = Schema.Struct({
  suiteIds: Schema.Array(QaSuiteId).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
  /** Replay against another origin, such as staging instead of production. */
  baseUrl: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2048))),
  /** False replays with healing off even where a suite turns it on. */
  heal: Schema.optional(Schema.Boolean),
  label: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
});
export type QaSuiteRunInput = typeof QaSuiteRunInput.Type;
export const QaSuiteRunStarted = Schema.Struct({ batchId: Schema.String });
export type QaSuiteRunStarted = typeof QaSuiteRunStarted.Type;

export const QaSuiteAcceptBaselineInput = Schema.Struct({
  suiteId: QaSuiteId,
  threadId: ThreadId,
  runId: QaRunId,
  scenarioIndex: NonNegativeInt,
});
export type QaSuiteAcceptBaselineInput = typeof QaSuiteAcceptBaselineInput.Type;

export const QaSuiteResolveProposalInput = Schema.Struct({
  suiteId: QaSuiteId,
  stepIndex: NonNegativeInt,
  accept: Schema.Boolean,
});
export type QaSuiteResolveProposalInput = typeof QaSuiteResolveProposalInput.Type;
/** The rerun an accepted fix started, with no AI. */
export const QaSuiteResolveProposalResult = Schema.Struct({
  batchId: Schema.NullOr(Schema.String),
});
export type QaSuiteResolveProposalResult = typeof QaSuiteResolveProposalResult.Type;

export class QaRunError extends Schema.TaggedError<QaRunError>()("QaRunError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
