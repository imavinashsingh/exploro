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
import type { PreviewAutomationSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as QaRecorder from "../../../qa/QaRecorder.ts";
import * as QaRuns from "../../../qa/QaRuns.ts";
import { QaToolkit } from "./tools.ts";

// Inline styles, not a <style> tag, so a strict page CSP cannot block the mask.
const MASK_PASSWORDS = `(() => {
  const masked = [];
  for (const input of document.querySelectorAll('input[type="password"]')) {
    masked.push([input, input.getAttribute("style")]);
    input.style.setProperty("color", "transparent", "important");
    input.style.setProperty("text-shadow", "none", "important");
    input.style.setProperty("-webkit-text-security", "none", "important");
  }
  globalThis.__exploroQaPasswordMask = masked;
  return masked.length;
})()`;
const UNMASK_PASSWORDS = `(() => {
  for (const [input, style] of globalThis.__exploroQaPasswordMask ?? []) {
    if (style === null) input.removeAttribute("style");
    else input.setAttribute("style", style);
  }
  delete globalThis.__exploroQaPasswordMask;
  return true;
})()`;

const decodePng = (data: string | undefined) =>
  data === undefined || data.length === 0 ? null : new Uint8Array(Buffer.from(data, "base64"));

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
  qa_evidence_record: McpToolAccess.actsAsCaller(({ tabId, ...input }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const qaRuns = yield* QaRuns.QaRuns;
      const tab = tabId === undefined ? {} : { tabId };
      const evaluate = (expression: string) =>
        broker
          .invoke({ scope, operation: "evaluate", input: { expression, ...tab }, ...tab })
          .pipe(Effect.ignore);
      // Saved evidence outlives the turn, so password fields are blanked, not just dotted.
      // The full-resolution capture is for people; the capped one is the fallback.
      const snapshot = yield* evaluate(MASK_PASSWORDS).pipe(
        Effect.andThen(
          broker.invoke<PreviewAutomationSnapshot>({
            scope,
            operation: "snapshot",
            input: { fullScreenshot: true },
            ...tab,
          }),
        ),
        Effect.ensuring(evaluate(UNMASK_PASSWORDS)),
      );
      return yield* qaRuns.recordEvidence(scope.thread.threadId, input, {
        url: snapshot.url,
        title: snapshot.title,
        png: decodePng(snapshot.fullScreenshot?.data ?? snapshot.screenshot.data),
        consoleEntries: snapshot.consoleEntries,
        networkEntries: snapshot.networkEntries,
        actionTimeline: snapshot.actionTimeline,
      });
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
