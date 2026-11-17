import { ProjectMemoryError } from "@t3tools/contracts";
import * as ProjectMemory from "../../../memory/ProjectMemory.ts";
import { formatProjectMap } from "../../../memory/projectMap.ts";
import {
  formatFactLine,
  formatUnderstandingLine,
  MEMORY_DATA_NOTE,
} from "../../../memory/memoryBrief.ts";
import { threadProvidedSecrets } from "../../../memory/providedSecrets.ts";
import * as ProjectUnderstanding from "../../../memory/ProjectUnderstanding.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import type { PreviewAutomationCheckResult, QaCheck } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as QaRecorder from "../../../qa/QaRecorder.ts";
import * as QaRuns from "../../../qa/QaRuns.ts";
import * as QaSuites from "../../../qa/QaSuites.ts";
import { capturePage } from "../../../qa/qaCapture.ts";
import { checkFor } from "../../../qa/qaReplay.ts";

const RECORD_CHECK_TIMEOUT_MS = 1_500;
import { QaToolkit } from "./tools.ts";

// Only threads of a project are granted memory (`ProviderSessionManager`).
const memoryScope = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.requireThreadMcpCapability("memory");
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const thread = yield* threads
    .getThreadShell(scope.thread.threadId)
    .pipe(
      Effect.mapError(
        (cause) =>
          new ProjectMemoryError({ message: "Could not read this thread's project.", cause }),
      ),
    );
  if (thread === null)
    return yield* new ProjectMemoryError({ message: "This thread has no project memory." });
  return { threadId: scope.thread.threadId, projectId: thread.projectId };
});

export const layer = McpToolAccess.toLayer(QaToolkit, {
  memory_map: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const { projectId } = yield* memoryScope;
      const memory = yield* ProjectMemory.ProjectMemory;
      return { map: formatProjectMap(yield* memory.map(projectId)) };
    }),
  ),
  memory_fact_put: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { threadId, projectId } = yield* memoryScope;
      const memory = yield* ProjectMemory.ProjectMemory;
      const qaRuns = yield* QaRuns.QaRuns;
      const run = (yield* qaRuns.openRun(threadId)) ?? (yield* qaRuns.list(threadId))[0];
      if (run === undefined)
        return yield* new ProjectMemoryError({
          message:
            "This thread has no QA run yet. Record what you saw with qa_evidence_record first.",
        });
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const secrets = yield* threadProvidedSecrets(threads, threadId).pipe(
        Effect.mapError(
          (cause) => new ProjectMemoryError({ message: "Could not read this thread.", cause }),
        ),
      );
      const fact = yield* memory.putObservedFact(projectId, run, input, secrets);
      return fact === null
        ? { factId: null, note: "Not saved: the user deleted this fact before." }
        : { factId: fact.factId, note: `Saved for ${fact.environment}${fact.route}.` };
    }),
  ),
  memory_facts_lookup: McpToolAccess.readsAsCaller((lookup) =>
    Effect.gen(function* () {
      const { projectId } = yield* memoryScope;
      const memory = yield* ProjectMemory.ProjectMemory;
      const facts = yield* memory.lookupFacts(projectId, { ...lookup, limit: 60 });
      return {
        facts:
          facts.length === 0
            ? "No facts match."
            : [MEMORY_DATA_NOTE, ...facts.map(formatFactLine)].join("\n"),
      };
    }),
  ),
  memory_recall: McpToolAccess.readsAsCaller(({ query }) =>
    Effect.gen(function* () {
      const { projectId } = yield* memoryScope;
      const understanding = yield* ProjectUnderstanding.ProjectUnderstanding;
      const recalled = yield* understanding.recall(projectId, query, { limit: 8 });
      return {
        items:
          recalled.items.length === 0
            ? "Nothing learned matches."
            : [MEMORY_DATA_NOTE, ...recalled.items.map(formatUnderstandingLine)].join("\n"),
      };
    }),
  ),
  qa_evidence_record: McpToolAccess.actsAsCaller(({ tabId, checks: assertions, ...input }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const qaRuns = yield* QaRuns.QaRuns;
      const tab = tabId === undefined ? {} : { tabId };
      // Each check must hold on the live page now; the ones that do not are not saved.
      const kept: Array<QaCheck> = [];
      const droppedChecks: Array<{ readonly check: string; readonly reason: string }> = [];
      if (assertions !== undefined && assertions.length > 0) {
        const checked = yield* broker
          .invoke<PreviewAutomationCheckResult>({
            scope,
            operation: "check",
            input: { assertions, timeoutMs: RECORD_CHECK_TIMEOUT_MS, ...tab },
            timeoutMs: assertions.length * RECORD_CHECK_TIMEOUT_MS + 5_000,
            ...tab,
          })
          .pipe(Effect.orElseSucceed(() => ({ results: [] })));
        assertions.forEach((assertion, index) => {
          const result = checked.results[index];
          const check = result?.ok === true ? checkFor(assertion, result.target) : null;
          if (check !== null) kept.push(check);
          else
            droppedChecks.push({
              check: JSON.stringify(assertion),
              reason:
                result === undefined
                  ? "The browser could not check it."
                  : result.ok
                    ? "The element could not be named for a replay."
                    : result.actual,
            });
        });
      }
      const page = yield* capturePage(broker, scope, tabId);
      const scenario = yield* qaRuns.recordEvidence(scope.thread.threadId, input, page, kept);
      return { ...scenario, droppedChecks };
    }),
  ),
  qa_regression_list: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      return { suites: yield* (yield* QaSuites.QaSuites).list };
    }),
  ),
  qa_regression_run: McpToolAccess.writes(({ suiteId, baseUrl }) =>
    Effect.gen(function* () {
      const suites = yield* QaSuites.QaSuites;
      const { runs } = yield* suites.run({
        suiteIds: [suiteId],
        ...(baseUrl === undefined ? {} : { baseUrl }),
      });
      return { runs };
    }),
  ),
  qa_report_finish: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
      const recorder = yield* QaRecorder.QaRecorder;
      return { run: yield* recorder.finish(scope.thread.threadId) };
    }),
  ),
});
