import {
  OrchestratorMcpFailure,
  PreviewAutomationError,
  PreviewTabId,
  QaEvidenceRecordInput,
  QaRun,
  QaRunError,
  QaRunId,
  QaScenario,
  QaSuiteCreateResult,
  QaSuiteId,
  QaSuiteSummary,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as QaRecorder from "../../../qa/QaRecorder.ts";
import * as QaRuns from "../../../qa/QaRuns.ts";
import * as QaSuites from "../../../qa/QaSuites.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  PreviewAutomationBroker.PreviewAutomationBroker,
  QaRuns.QaRuns,
  QaRecorder.QaRecorder,
];

const failure = Schema.Union([PreviewAutomationError, OrchestratorMcpFailure, QaRunError]);

const QaEvidenceRecordTool = Tool.make("qa_evidence_record", {
  description:
    "Record one scenario's verdict with evidence. Takes a full screenshot of the tab and saves its console and network logs to this run's evidence folder. Call it once per verdict, right after you observed the result, while the page still shows it. A PASS or FAIL without a screenshot is stored as INCONCLUSIVE. For a FAIL, give `expected`, `actual`, `severity` and `steps` so it reads as a bug report. For a PASS, give `checks` that prove it (textVisible, urlIncludes, elementVisible or valueEquals with `locator='aria-ref=<ref>'`): each is checked on the live page now, and only those that hold are kept, so the run can be replayed later without a model. `droppedChecks` says which did not hold.",
  parameters: Schema.Struct({
    ...QaEvidenceRecordInput.fields,
    tabId: Schema.optional(PreviewTabId),
  }),
  success: Schema.Struct({
    ...QaScenario.fields,
    droppedChecks: Schema.Array(Schema.Struct({ check: Schema.String, reason: Schema.String })),
  }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Record QA evidence")
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const QaReportFinishTool = Tool.make("qa_report_finish", {
  description:
    "Finish this QA run: stop its video and write report.md and report.html to the run folder. Call it once after your last verdict. The run also finishes on its own when your turn ends.",
  success: Schema.Struct({ run: Schema.NullOr(QaRun) }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Finish QA report")
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const regressionDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  QaSuites.QaSuites,
];

const QaRegressionListTool = Tool.make("qa_regression_list", {
  description:
    "List saved regression suites: passed QA runs a replay repeats without a model. Each has a suiteId for qa_regression_run. qa_regression_save makes one from a finished run.",
  success: Schema.Struct({ suites: Schema.Array(QaSuiteSummary) }),
  failure,
  dependencies: regressionDependencies,
})
  .annotate(Tool.Title, "List regression suites")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const QaRegressionSaveTool = Tool.make("qa_regression_save", {
  description:
    "Save a finished QA test run of this thread as a regression suite that replays without a model. Defaults to the thread's latest test run; call qa_report_finish first if it is still open. Only PASS scenarios with saved checks are kept; `skipped` says which were left out and why. Returns the suite for qa_regression_run.",
  parameters: Schema.Struct({
    runId: Schema.optional(QaRunId),
    name: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  }),
  success: QaSuiteCreateResult,
  failure,
  dependencies: regressionDependencies,
})
  .annotate(Tool.Title, "Save regression suite")
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const QaRegressionRunTool = Tool.make("qa_regression_run", {
  description:
    "Replay a regression suite in a fresh browser tab without a model, and wait for its verdicts: one run, or one per data set row. PASS: every saved check held and the page looks like its baseline. FAIL: a check failed or the page looks different. INCONCLUSIVE: a step could not run, so the test needs updating; that is not a product bug. Runs in the thread the suite was saved from. `baseUrl` replays against another origin, such as staging.",
  parameters: Schema.Struct({
    suiteId: QaSuiteId,
    baseUrl: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))),
  }),
  success: Schema.Struct({ runs: Schema.Array(QaRun) }),
  failure,
  dependencies: regressionDependencies,
})
  .annotate(Tool.Title, "Run regression suite")
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Destructive, false);

export const QaToolkit = Toolkit.make(
  QaRegressionListTool,
  QaRegressionSaveTool,
  QaRegressionRunTool,
  QaEvidenceRecordTool,
  QaReportFinishTool,
);
