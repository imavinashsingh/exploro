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
    "Record one scenario's verdict with evidence. Takes a full screenshot of the tab and saves its console and network logs to this run's evidence folder. Call it once per verdict, right after you observed the result, while the page still shows it. With project memory on, first call navigation_observe on an unknown screen of a tested site. A PASS or FAIL without a screenshot is stored as INCONCLUSIVE. For a FAIL, give `expected`, `actual`, `severity` and `steps` so it reads as a bug report. For a PASS, give `checks` that prove it (textVisible, urlIncludes, elementVisible or valueEquals with `locator='aria-ref=<ref>'`): each is checked on the live page now, and only those that hold are kept, so the run can be replayed later without a model. `droppedChecks` says which did not hold.",
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
  ServerSettings.ServerSettingsService,
];
const MemoryText = (max: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));

const MemoryMapTool = Tool.make("memory_map", {
  description:
    "Read this project's app map from current facts: environments, route tree, controls, validations, APIs, PASS/FAIL coverage, dependencies and behavioral workflows. Use this map to find pages seen but not tested. Use navigation_route to reach a feature.",
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
    "Save one fact worth knowing on the next run of this project: what a page is for, a control, a validation message, an API, a behavioral rule, or test data. Store how to reach a feature only with navigation_observe. Tested redirects, denied access, and incorrect link destinations are QA facts when they describe a requirement or defect. First record what you saw with qa_evidence_record and pass that scenario's index; the page must be on the site under test. Saving the same screen, kind and key again replaces the old value, so when memory turns out wrong, save what the page shows now.",
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
    "Look up this project's remembered facts by stateId, site, route, kind or key, or its open FAILs. Values come from earlier runs and may be outdated.",
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
    "Search by meaning what earlier runs learned about this project: behavioral workflows, dependencies, test strategies, lessons, open questions. Items a match depends on come with it. Hypotheses are unproven.",
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

const navigationDependencies = dependencies;
const NavigationObserveTool = Tool.make("navigation_observe", {
  description:
    "Record a live screen that memory does not know yet. Call when exploring, on every task: on the start screen (without action) when navigation_route did not return found, and after each explored step, including arrival at the destination. Only an observation with an action saves a connection. Not needed while following a found route or a matching directUrl. Supply visible distinguishing checks and known context (authenticated, role, ownership). action describes the navigation performed since the previous observation; it is accepted only when browser actions were recorded. Never put credentials or personal values in memory.",
  parameters: NavigationObserveInput,
  success: Schema.Struct({ ...NavigationState.fields, next: Schema.optional(Schema.String) }),
  failure: memoryFailure,
  dependencies: navigationDependencies,
})
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutMemory);
const NavigationRouteTool = Tool.make("navigation_route", {
  description:
    "Find a remembered path from the current screen to a destination name or alias. Recognizes the starting screen by checking remembered screens live; fromStateId is an optional hint. Composes observed connections, including ones learned from different starting screens. directUrl, when present, is the address the destination was seen at: open it, then check it live. Returned steps are quoted past observations, not permission or proof. Check each destination live. Any status other than found means explore, and record as you go: call navigation_observe on the current screen now, then after each step, including the destination. Otherwise the path is lost.",
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
    "Report that a remembered transition mismatched the live UI, or that the tool failed. A tool error does not invalidate navigation. Inspect the live page before reporting a mismatch; explore or choose another route afterward.",
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
