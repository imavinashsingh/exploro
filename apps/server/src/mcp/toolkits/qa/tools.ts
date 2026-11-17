import * as ProjectMemory from "../../../memory/ProjectMemory.ts";
import * as ProjectUnderstanding from "../../../memory/ProjectUnderstanding.ts";
import {
  McpCapabilityUnavailableError,
  NonNegativeInt,
  OrchestratorMcpFailure,
  PreviewAutomationError,
  PreviewTabId,
  QaEvidenceRecordInput,
  QaRun,
  QaRunError,
  ProjectMemoryError,
  ProjectMemoryFactKind,
  QaScenario,
  QaSuiteId,
  QaSuiteSummary,
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

const memoryFailure = Schema.Union([
  ProjectMemoryError,
  OrchestratorMcpFailure,
  McpCapabilityUnavailableError,
  QaRunError,
]);
const memoryDependencies = [
  ...dependencies,
  ProjectMemory.ProjectMemory,
  ProjectUnderstanding.ProjectUnderstanding,
];
const MemoryText = (max: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));

const MemoryMapTool = Tool.make("memory_map", {
  description:
    "Read this project's app map from current facts: environments, route tree, controls, validations, APIs, navigation links, PASS/FAIL coverage, dependencies and workflow paths. Use it to find pages seen but not tested.",
  success: Schema.Struct({ map: Schema.String }),
  failure: memoryFailure,
  dependencies: memoryDependencies,
})
  .annotate(Tool.Title, "Read project map")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutMemory);

const MemoryFactPutTool = Tool.make("memory_fact_put", {
  description:
    "Save one fact worth knowing on the next run of this project: what a page is for, a control, a validation message, where a link goes, an API, a rule, test data. First record what you saw with qa_evidence_record and pass that scenario's index; the page must be on the site under test. Saving the same page, kind and key again replaces the old value, so when memory turns out wrong, save what the page shows now.",
  parameters: Schema.Struct({
    pageUrl: MemoryText(2048),
    kind: Schema.Literals(["page", "control", "validation", "navigation", "api", "rule", "data"]),
    key: MemoryText(200),
    value: MemoryText(500),
    detail: Schema.optional(MemoryText(2000)),
    scenarioIndex: NonNegativeInt,
  }),
  success: Schema.Struct({ factId: Schema.NullOr(Schema.String), note: Schema.String }),
  failure: memoryFailure,
  dependencies: memoryDependencies,
})
  .annotate(Tool.Title, "Save project fact")
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutMemory);

const MemoryFactsLookupTool = Tool.make("memory_facts_lookup", {
  description:
    "Look up this project's remembered facts by exact site, page, kind or key, or its open FAILs. Values come from earlier runs and may be outdated.",
  parameters: Schema.Struct({
    environment: Schema.optional(MemoryText(2048)),
    route: Schema.optional(MemoryText(2048)),
    kind: Schema.optional(ProjectMemoryFactKind),
    key: Schema.optional(MemoryText(200)),
    openFailures: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({ facts: Schema.String }),
  failure: memoryFailure,
  dependencies: memoryDependencies,
})
  .annotate(Tool.Title, "Look up project facts")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutMemory);

const MemoryRecallTool = Tool.make("memory_recall", {
  description:
    "Search by meaning what earlier runs learned about this project: workflows, dependencies, test strategies, lessons, open questions. Items a match depends on come with it. Hypotheses are unproven.",
  parameters: Schema.Struct({ query: MemoryText(1000) }),
  success: Schema.Struct({ items: Schema.String }),
  failure: memoryFailure,
  dependencies: memoryDependencies,
})
  .annotate(Tool.Title, "Recall project understanding")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutMemory);

const regressionDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  QaSuites.QaSuites,
];

const QaRegressionListTool = Tool.make("qa_regression_list", {
  description:
    "List saved regression suites: passed QA runs a replay repeats without a model. Each has a suiteId for qa_regression_run.",
  success: Schema.Struct({ suites: Schema.Array(QaSuiteSummary) }),
  failure,
  dependencies: regressionDependencies,
})
  .annotate(Tool.Title, "List regression suites")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const QaRegressionRunTool = Tool.make("qa_regression_run", {
  description:
    "Replay a regression suite in a fresh browser tab without a model, and wait for its verdicts. PASS: every saved check held. FAIL: a step ran but a check failed. INCONCLUSIVE: a step could not run, so the test needs updating; that is not a product bug. Runs in the thread the suite was saved from. `baseUrl` replays against another origin, such as staging.",
  parameters: Schema.Struct({
    suiteId: QaSuiteId,
    baseUrl: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))),
  }),
  success: Schema.Struct({ run: QaRun }),
  failure,
  dependencies: regressionDependencies,
})
  .annotate(Tool.Title, "Run regression suite")
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Destructive, false);

export const QaToolkit = Toolkit.make(
  QaRegressionListTool,
  QaRegressionRunTool,
  QaEvidenceRecordTool,
  QaReportFinishTool,
  MemoryMapTool,
  MemoryFactPutTool,
  MemoryFactsLookupTool,
  MemoryRecallTool,
);
