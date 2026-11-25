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

export const layer = McpToolAccess.toLayer(QaToolkit, {
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
  qa_regression_save: McpToolAccess.actsAsCaller(({ runId, name }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
      return yield* (yield* QaSuites.QaSuites).create({
        threadId: scope.thread.threadId,
        ...(runId === undefined ? {} : { runId }),
        ...(name === undefined ? {} : { name }),
      });
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
