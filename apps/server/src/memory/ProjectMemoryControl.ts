import * as ProjectNavigationMemory from "./ProjectNavigationMemory.ts";
import * as Option from "effect/Option";
import {
  ProjectMemoryError,
  type ProjectId,
  type ThreadId,
  type ProjectMemorySnapshot,
  type ProjectUnderstandingItem,
  type ProjectUnderstandingVersion,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { threadHasUnfinishedWork } from "../orchestration-v2/Orchestrator.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as QaRuns from "../qa/QaRuns.ts";
import { memoryEnabled } from "./ProjectMemoryAccess.ts";
import { providedSecrets } from "./providedSecrets.ts";
import * as ProjectMemory from "./ProjectMemory.ts";
import * as ProjectUnderstanding from "./ProjectUnderstanding.ts";
import * as UnderstandingExtraction from "./UnderstandingExtraction.ts";

const SNAPSHOT_FACT_LIMIT = 2000;

/** What the user does with a project's memory from the Memory screen. */
export class ProjectMemoryControl extends Context.Service<
  ProjectMemoryControl,
  {
    readonly saveThread: (threadId: ThreadId) => Effect.Effect<void, ProjectMemoryError>;
    readonly setAppVersion: (input: {
      readonly projectId: ProjectId;
      readonly environment: string;
      readonly appVersion: string;
    }) => Effect.Effect<void, ProjectMemoryError>;
    readonly snapshot: (
      projectId: ProjectId,
    ) => Effect.Effect<ProjectMemorySnapshot, ProjectMemoryError>;
    readonly deleteFact: (
      projectId: ProjectId,
      factId: string,
    ) => Effect.Effect<void, ProjectMemoryError>;
    readonly itemHistory: (
      projectId: ProjectId,
      itemId: string,
    ) => Effect.Effect<ReadonlyArray<ProjectUnderstandingVersion>, ProjectMemoryError>;
    /** The user's rewrite or confirmation; a confirmed item stays confirmed unless told otherwise. */
    readonly updateItem: (input: {
      readonly projectId: ProjectId;
      readonly itemId: string;
      readonly statement?: string | undefined;
      readonly confirm?: boolean | undefined;
    }) => Effect.Effect<ProjectUnderstandingItem, ProjectMemoryError>;
    readonly deleteItem: (
      projectId: ProjectId,
      itemId: string,
    ) => Effect.Effect<void, ProjectMemoryError>;
    readonly retryExtraction: (
      projectId: ProjectId,
      runId: string,
    ) => Effect.Effect<void, ProjectMemoryError>;
  }
>()("t3/memory/ProjectMemoryControl") {}

const make = Effect.gen(function* () {
  const memory = yield* ProjectMemory.ProjectMemory;
  const navigation = yield* Effect.serviceOption(ProjectNavigationMemory.ProjectNavigationMemory);
  const understanding = yield* ProjectUnderstanding.ProjectUnderstanding;
  const extraction = yield* UnderstandingExtraction.UnderstandingExtraction;

  const threads = yield* ThreadManagementService.ThreadManagementService;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const settings = yield* ServerSettings.ServerSettingsService;
  const runs = yield* QaRuns.QaRuns;

  return ProjectMemoryControl.of({
    saveThread: Effect.fn("ProjectMemoryControl.saveThread")(function* (threadId) {
      const records = yield* threads
        .getThreadRecords(threadId, ["runs", "runtimeRequests", "messages"], {
          messageRoles: ["user"],
        })
        .pipe(
          Effect.mapError(
            (cause) => new ProjectMemoryError({ message: "Could not read the thread.", cause }),
          ),
        );
      if (records.thread.deletedAt !== null || threadHasUnfinishedWork(records)) {
        return yield* new ProjectMemoryError({
          message: "Finish or stop this test before saving it to memory.",
        });
      }
      const projectId = records.thread.projectId;
      if (yield* folders.isScratchProject(projectId)) {
        return yield* new ProjectMemoryError({
          message: "Move this test into a project before saving it to memory.",
        });
      }
      const current = yield* settings.getSettings.pipe(
        Effect.mapError(
          (cause) => new ProjectMemoryError({ message: "Could not read memory settings.", cause }),
        ),
      );
      if (!memoryEnabled(current, projectId)) {
        return yield* new ProjectMemoryError({ message: "Memory is off for this project." });
      }
      const secrets = providedSecrets(records.messages.map((message) => message.text));
      const savedRuns = yield* runs
        .list(threadId)
        .pipe(
          Effect.mapError(
            (cause) => new ProjectMemoryError({ message: "Could not read the test runs.", cause }),
          ),
        );
      const candidates =
        savedRuns.length > 0
          ? savedRuns
          : [
              yield* runs
                .ensureRun(threadId, { site: null })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProjectMemoryError({ message: "Could not create a memory run.", cause }),
                  ),
                ),
            ];
      for (const run of candidates) {
        if (run.projectId !== null && run.projectId !== projectId) continue;
        const saved = yield* runs
          .rememberRun(threadId, run.runId, projectId, secrets)
          .pipe(
            Effect.mapError(
              (cause) => new ProjectMemoryError({ message: "Could not save the test run.", cause }),
            ),
          );
        yield* extraction.enqueue(saved);
      }
    }),
    setAppVersion: Effect.fn("ProjectMemoryControl.setAppVersion")(function* (input) {
      const saved = yield* memory.putFact(input.projectId, {
        environment: input.environment,
        route: "/",
        kind: "data",
        key: "Tested app version",
        value: input.appVersion,
        appVersion: input.appVersion,
        evidence: [],
        author: "user",
      });
      if (saved === null)
        return yield* new ProjectMemoryError({
          message: "This version was deleted from memory. Use a different version label.",
        });
    }),
    snapshot: Effect.fn("ProjectMemoryControl.snapshot")(function* (projectId) {
      const facts = yield* memory.listFacts(projectId, SNAPSHOT_FACT_LIMIT + 1);
      return {
        ...(Option.isSome(navigation)
          ? { navigation: yield* navigation.value.snapshot(projectId) }
          : {}),
        facts: facts.slice(0, SNAPSHOT_FACT_LIMIT),
        factsTruncated: facts.length > SNAPSHOT_FACT_LIMIT,
        understanding: yield* understanding.getItems(projectId),
        status: yield* extraction.status(projectId),
      };
    }),
    deleteFact: memory.deleteFact,
    itemHistory: understanding.history,
    updateItem: Effect.fn("ProjectMemoryControl.updateItem")(function* (input) {
      const [current] = yield* understanding.getItems(input.projectId, [input.itemId]);
      if (current === undefined) {
        return yield* new ProjectMemoryError({ message: "That item no longer exists." });
      }
      const [saved] = yield* understanding.saveItems(
        input.projectId,
        [
          {
            ref: current.itemId,
            itemId: current.itemId,
            kind: current.kind,
            statement: input.statement ?? current.statement,
            citedFactIds: current.citedFactIds,
            dependsOn: current.dependsOn,
            author: "user",
            confirm: input.confirm ?? current.status === "confirmed",
          },
        ],
        { environment: null },
      );
      return saved ?? current;
    }),
    deleteItem: understanding.deleteItem,
    retryExtraction: extraction.retry,
  });
});

export const layer = Layer.effect(ProjectMemoryControl, make);
