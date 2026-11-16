import { ProjectMemoryError, type ProjectId, type QaRun, type ThreadId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as QaRuns from "../qa/QaRuns.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as MemoryEmbedder from "./MemoryEmbedder.ts";
import * as ProjectMemory from "./ProjectMemory.ts";
import * as ProjectUnderstanding from "./ProjectUnderstanding.ts";
import { memoryEnvironment } from "./projectMemoryFacts.ts";
import { hideProvidedSecrets, providedSecrets } from "./providedSecrets.ts";
import { buildExtractionPrompt, planUnderstandingWrites } from "./understandingPrompt.ts";

export interface ProjectMemoryStatus {
  readonly recall: "semantic" | "text";
  /** Why recall is text-only; null while semantic recall works. */
  readonly recallNote: string | null;
  readonly pendingExtractions: number;
  readonly failedExtractions: ReadonlyArray<{ readonly runId: string; readonly error: string }>;
}

/**
 * Learns understanding from finished runs in the background, one structured generation per run,
 * so the testing turn never waits on it and a failure never touches the run or its report.
 */
export class UnderstandingExtraction extends Context.Service<
  UnderstandingExtraction,
  {
    /** Queues a finished run of a project; project-less runs are ignored. */
    readonly enqueue: (run: QaRun) => Effect.Effect<void, ProjectMemoryError>;
    /** Runs one queued extraction now and records whether it worked. */
    readonly extract: (runId: string) => Effect.Effect<void>;
    readonly retry: (
      projectId: ProjectId,
      runId: string,
    ) => Effect.Effect<void, ProjectMemoryError>;
    readonly status: (
      projectId: ProjectId,
    ) => Effect.Effect<ProjectMemoryStatus, ProjectMemoryError>;
  }
>()("t3/memory/UnderstandingExtraction") {}

const errorText = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "message" in error &&
  typeof error.message === "string"
    ? error.message
    : String(error);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const memory = yield* ProjectMemory.ProjectMemory;
  const understanding = yield* ProjectUnderstanding.ProjectUnderstanding;
  const embedder = yield* MemoryEmbedder.MemoryEmbedder;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const qaRuns = yield* QaRuns.QaRuns;
  const queue = yield* Queue.unbounded<string>();

  const nowIso = Effect.map(Clock.currentTimeMillis, (millis) =>
    DateTime.formatIso(DateTime.makeUnsafe(millis)),
  );
  const fail = (message: string) => (cause: unknown) => new ProjectMemoryError({ message, cause });

  const markStatus = (runId: string, status: string, error: string | null) =>
    Effect.flatMap(
      nowIso,
      (updatedAt) => sql`
        UPDATE project_memory_extractions
        SET status = ${status}, error = ${error}, updated_at = ${updatedAt}
        WHERE run_id = ${runId}
      `,
    );

  const learn = Effect.fnUntraced(function* (
    projectId: ProjectId,
    threadId: ThreadId,
    runId: string,
  ) {
    const facts = yield* memory.lookupFacts(projectId, { runId, limit: 100 });
    const records = yield* threads.getThreadRecords(threadId, ["messages"], {
      messageRoles: ["user"],
    });
    const typed = records.messages
      .filter((message) => !message.streaming && message.text.trim().length > 0)
      .map((message) => message.text);
    // The model never sees the user's passwords, so it cannot copy them into memory.
    const secrets = providedSecrets(typed);
    const userMessages = typed.map((text) => hideProvidedSecrets(text, secrets));
    if (facts.length === 0 && userMessages.length === 0) return;
    const project = yield* projects.get(projectId);
    if (Option.isNone(project)) return;
    // The site under test, not where a link led: facts from other sites never verify an item.
    const run = (yield* qaRuns.list(threadId)).find((candidate) => candidate.runId === runId);
    const environment =
      (run?.site == null ? null : memoryEnvironment(run.site)) ?? facts[0]?.environment ?? null;
    const related = yield* understanding.recall(
      projectId,
      [...facts.map((fact) => `${fact.key} ${fact.value}`), ...userMessages].join("\n"),
      { limit: 15 },
    );
    const input = {
      projectTitle: project.value.title,
      site: environment,
      facts,
      related: related.items.map(({ item }) => item),
      userMessages,
    };
    const settings = resolveProjectSettings(yield* serverSettings.getSettings, projectId).settings;
    const output = yield* textGeneration.generateProjectUnderstanding({
      cwd: project.value.workspaceRoot,
      prompt: buildExtractionPrompt(input),
      modelSelection: settings.textGenerationModelSelection,
      projectId,
    });
    const planned = planUnderstandingWrites(output, input).map((write) => ({
      ...write,
      statement: hideProvidedSecrets(write.statement, secrets),
      userQuote: write.userQuote === null ? null : hideProvidedSecrets(write.userQuote, secrets),
    }));
    const writes = yield* Effect.forEach(planned, ({ userQuote, ...write }) =>
      Effect.gen(function* () {
        if (userQuote === null || environment === null)
          return { ...write, author: "agent" as const };
        const userFact = yield* memory.putFact(projectId, {
          environment,
          route: "/",
          kind: "rule",
          key: userQuote.slice(0, 200),
          value: userQuote.slice(0, 500),
          evidence: [],
          author: "user",
        });
        return {
          ...write,
          citedFactIds:
            userFact === null ? write.citedFactIds : [...write.citedFactIds, userFact.factId],
          author: "agent" as const,
        };
      }),
    );
    yield* understanding.saveItems(projectId, writes, { environment });
  });

  const extract: UnderstandingExtraction["Service"]["extract"] = Effect.fn(
    "UnderstandingExtraction.extract",
  )(function* (runId) {
    const rows = yield* sql<{
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly status: string;
    }>`
      SELECT project_id AS "projectId", thread_id AS "threadId", status
      FROM project_memory_extractions WHERE run_id = ${runId}
    `.pipe(Effect.orElseSucceed(() => []));
    const row = rows[0];
    if (row === undefined || row.status === "done") return;
    const updatedAt = yield* nowIso;
    yield* sql`
      UPDATE project_memory_extractions
      SET status = 'running', attempts = attempts + 1, updated_at = ${updatedAt}
      WHERE run_id = ${runId}
    `.pipe(Effect.ignore);
    yield* learn(row.projectId, row.threadId, runId).pipe(
      Effect.andThen(markStatus(runId, "done", null)),
      Effect.catchCause((cause) =>
        Effect.logWarning("Project understanding was not extracted", { runId, cause }).pipe(
          Effect.andThen(markStatus(runId, "failed", errorText(cause))),
        ),
      ),
      Effect.ignore,
    );
  });

  yield* Queue.take(queue).pipe(Effect.flatMap(extract), Effect.forever, Effect.forkScoped);

  // Extractions a restart interrupted run again.
  const unfinished = yield* sql<{ readonly runId: string }>`
    SELECT run_id AS "runId" FROM project_memory_extractions
    WHERE status IN ('pending', 'running') ORDER BY updated_at
  `.pipe(Effect.orElseSucceed(() => []));
  yield* Queue.offerAll(
    queue,
    unfinished.map((row) => row.runId),
  );

  return UnderstandingExtraction.of({
    enqueue: Effect.fn("UnderstandingExtraction.enqueue")(
      function* (run) {
        if (run.projectId === null || run.finishedAt === null) return;
        const updatedAt = yield* nowIso;
        yield* sql`
          INSERT INTO project_memory_extractions (
            run_id, project_id, thread_id, status, error, attempts, updated_at
          ) VALUES (${run.runId}, ${run.projectId}, ${run.threadId}, 'pending', NULL, 0, ${updatedAt})
          ON CONFLICT (run_id) DO UPDATE SET status = 'pending', error = NULL,
            updated_at = excluded.updated_at
        `;
        yield* Queue.offer(queue, run.runId);
      },
      Effect.mapError(fail("Could not queue the run for project memory.")),
    ),
    extract,
    retry: Effect.fn("UnderstandingExtraction.retry")(
      function* (projectId, runId) {
        const updatedAt = yield* nowIso;
        const rows = yield* sql`
          UPDATE project_memory_extractions
          SET status = 'pending', error = NULL, updated_at = ${updatedAt}
          WHERE run_id = ${runId} AND project_id = ${projectId} AND status = 'failed'
          RETURNING run_id
        `;
        if (rows.length > 0) yield* Queue.offer(queue, runId);
      },
      Effect.mapError(fail("Could not retry the extraction.")),
    ),
    status: Effect.fn("UnderstandingExtraction.status")(
      function* (projectId) {
        const rows = yield* sql<{
          readonly runId: string;
          readonly status: string;
          readonly error: string | null;
        }>`
          SELECT run_id AS "runId", status, error FROM project_memory_extractions
          WHERE project_id = ${projectId} AND status != 'done'
          ORDER BY updated_at DESC
        `;
        const embedding = yield* embedder.status;
        return {
          recall: embedding.unavailableReason === null ? "semantic" : "text",
          recallNote: embedding.unavailableReason,
          pendingExtractions: rows.filter((row) => row.status !== "failed").length,
          failedExtractions: rows
            .filter((row) => row.status === "failed")
            .map((row) => ({ runId: row.runId, error: row.error ?? "Unknown error" })),
        } satisfies ProjectMemoryStatus;
      },
      Effect.mapError(fail("Could not read the project's memory status.")),
    ),
  });
});

export const layer = Layer.effect(UnderstandingExtraction, make);
