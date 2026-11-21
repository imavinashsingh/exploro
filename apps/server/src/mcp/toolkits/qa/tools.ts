import * as ServerSettings from "../../../serverSettings.ts";
import {
  NavigationObserveInput,
  NavigationState,
  NavigationRouteInput,
  NavigationRouteResult,
  NavigationFeedbackInput,
} from "@t3tools/contracts";
import * as NavigationCapture from "../../../memory/NavigationCapture.ts";
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
  NavigationCapture.NavigationCapture,
];

const failure = Schema.Union([
  PreviewAutomationError,
  OrchestratorMcpFailure,
  QaRunError,
  ProjectMemoryError,
]);

const QaEvidenceRecordTool = Tool.make("qa_evidence_record", {
  description:
    "Record one scenario's verdict: saves a screenshot and the tab's console and network logs. Call once per verdict, while the page still shows the result. A PASS or FAIL without a screenshot is stored as INCONCLUSIVE. FAIL: give `expected`, `actual`, `severity`, `steps`. PASS: give `checks` that prove it (`locator='aria-ref=<ref>'` for elements); only those that hold live are kept for model-free replay, and `droppedChecks` lists the rest.",
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
    "Finish this QA run after your last verdict: stops its video and writes report.md and report.html to the run folder. It also finishes when your turn ends.",
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
  ServerSettings.ServerSettingsService,
];
const MemoryText = (max: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));

const MemoryMapTool = Tool.make("memory_map", {
  description:
    "Read the app map from current facts: routes, controls, validations, APIs, PASS/FAIL coverage and workflows. Shows pages seen but not tested.",
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
    "Save one fact for the next run: what a page is for, a control, a validation message, an API, a behavioral rule, or test data. How to reach a feature is not a fact; a tested redirect or denied access is. Record evidence with qa_evidence_record first and pass its scenarioIndex. The same screen, kind and key replaces the old value.",
  parameters: Schema.Struct({
    kind: Schema.Literals(["page", "control", "validation", "api", "rule", "data"]),
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
    "Look up remembered facts by stateId, site, route, kind or key, or open FAILs. They may be outdated.",
  parameters: Schema.Struct({
    stateId: Schema.optional(MemoryText(200)),
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
    "Search by meaning what earlier runs learned: workflows, dependencies, test strategies, lessons, open questions, with the items each depends on. Hypotheses are unproven.",
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
    "Replay a saved suite in a fresh tab without a model and wait for its verdicts, one run per data set row. PASS: every check held and the page matches its baseline. FAIL: a check failed or the page differs. INCONCLUSIVE: a step could not run; update the test, it is not a product bug. `baseUrl` replays on another origin, such as staging.",
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

const navigationDependencies = dependencies;
const NavigationObserveTool = Tool.make("navigation_observe", {
  description:
    "Record the live screen while exploring, on every task: the start screen without an action when navigation_route did not return found, then after each step with the action you took, through the destination. Only an observation with an action saves a connection. Give visible checks and known context (signed in, role). No credentials or personal values.",
  parameters: NavigationObserveInput,
  success: Schema.Struct({ ...NavigationState.fields, next: Schema.optional(Schema.String) }),
  failure: memoryFailure,
  dependencies: navigationDependencies,
})
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutMemory);
const NavigationRouteTool = Tool.make("navigation_route", {
  description:
    "Find a remembered path from the current screen to a destination name or alias. Steps are past observations, not proof: check each screen live. With directUrl, open it, then check it. Any status but found: explore, calling navigation_observe now and after each step.",
  parameters: NavigationRouteInput,
  success: NavigationRouteResult,
  failure: memoryFailure,
  dependencies: navigationDependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutMemory);
const NavigationFeedbackTool = Tool.make("navigation_feedback", {
  description:
    "Report a remembered transition that mismatched the live page (inspect it first), or a tool error, then explore.",
  parameters: NavigationFeedbackInput,
  success: Schema.Void,
  failure: memoryFailure,
  dependencies: navigationDependencies,
})
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutMemory);

export const QaToolkit = Toolkit.make(
  NavigationObserveTool,
  NavigationRouteTool,
  NavigationFeedbackTool,
  QaRegressionListTool,
  QaRegressionRunTool,
  QaEvidenceRecordTool,
  QaReportFinishTool,
  MemoryMapTool,
  MemoryFactPutTool,
  MemoryFactsLookupTool,
  MemoryRecallTool,
);
