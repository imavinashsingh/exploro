import * as ProjectNavigationMemory from "./ProjectNavigationMemory.ts";
import * as Option from "effect/Option";
import {
  ProjectMemoryError,
  type MemoryDoc,
  type MemoryProposal,
  type ProjectId,
  type ThreadId,
  type ProjectMemorySnapshot,
  type ProjectUnderstandingItem,
  type ProjectUnderstandingVersion,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { threadHasUnfinishedWork } from "../orchestration-v2/Orchestrator.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as QaRuns from "../qa/QaRuns.ts";
import * as MarkdownMemoryStore from "./MarkdownMemoryStore.ts";
import { memoryEnabled } from "./ProjectMemoryAccess.ts";
import { memoryEnvironment } from "./projectMemoryFacts.ts";
import { providedSecrets } from "./providedSecrets.ts";
import * as ProjectMemory from "./ProjectMemory.ts";
import * as ProjectUnderstanding from "./ProjectUnderstanding.ts";
import * as UnderstandingExtraction from "./UnderstandingExtraction.ts";

const SNAPSHOT_FACT_LIMIT = 2000;
const SNAPSHOT_ISSUE_LIMIT = 200;

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
    /** The user's own playbook or guide; it is saved confirmed. */
    readonly saveDoc: (input: {
      readonly projectId: ProjectId;
      readonly kind: MemoryDoc["kind"];
      readonly slug: string;
      readonly title: string;
      readonly summary: string;
      readonly environment?: string | null | undefined;
      readonly routes: ReadonlyArray<string>;
      readonly keywords: ReadonlyArray<string>;
      readonly body: string;
    }) => Effect.Effect<MemoryDoc, ProjectMemoryError>;
    readonly approveProposal: (input: {
      readonly projectId: ProjectId;
      readonly proposalId: string;
      readonly replaceConfirmed?: boolean | undefined;
    }) => Effect.Effect<MemoryProposal, ProjectMemoryError>;
    readonly dismissProposal: (input: {
      readonly projectId: ProjectId;
      readonly proposalId: string;
    }) => Effect.Effect<MemoryProposal, ProjectMemoryError>;
  }
>()("t3/memory/ProjectMemoryControl") {}

const nowIso = Effect.map(Clock.currentTimeMillis, (millis) =>
  DateTime.formatIso(DateTime.makeUnsafe(millis)),
);

const make = Effect.gen(function* () {
  const memory = yield* ProjectMemory.ProjectMemory;
  const navigation = yield* Effect.serviceOption(ProjectNavigationMemory.ProjectNavigationMemory);
  const understanding = yield* ProjectUnderstanding.ProjectUnderstanding;
  const extraction = yield* UnderstandingExtraction.UnderstandingExtraction;

  const threads = yield* ThreadManagementService.ThreadManagementService;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const settings = yield* ServerSettings.ServerSettingsService;
  const runs = yield* QaRuns.QaRuns;
  const docs = yield* MarkdownMemoryStore.MarkdownMemoryStore;

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
        if (run.kind === "regression") continue;
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
      const site = memoryEnvironment(input.environment);
      if (site === null)
        return yield* new ProjectMemoryError({
          message: "Choose a website to set its app version.",
        });
      const saved = yield* memory.putFact(input.projectId, {
        stateId: site,
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
        // Edits made to the files outside Exploro show up here too.
        // Active recall never migrates; the Memory screen brings confirmed legacy items over once.
        docs: yield* docs.migrateLegacyUnderstandingIfEmpty(projectId).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Legacy understanding was not exported", { error }),
          ),
          Effect.andThen(docs.syncProject(projectId)),
          Effect.andThen(docs.listDocs(projectId)),
        ),
        proposals: (yield* docs.listProposals(projectId)).filter(
          (proposal) => proposal.status === "pending",
        ),
        openIssues: yield* memory.lookupFacts(projectId, {
          openFailures: true,
          limit: SNAPSHOT_ISSUE_LIMIT,
        }),
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
    saveDoc: Effect.fn("ProjectMemoryControl.saveDoc")(function* (input) {
      return yield* docs.saveUserDoc({ ...input, updatedAt: yield* nowIso });
    }),
    approveProposal: Effect.fn("ProjectMemoryControl.approveProposal")(function* (input) {
      return yield* docs.resolveProposal({ ...input, decision: "approve" });
    }),
    dismissProposal: Effect.fn("ProjectMemoryControl.dismissProposal")(function* (input) {
      return yield* docs.resolveProposal({ ...input, decision: "dismiss" });
    }),
  });
});

export const layer = Layer.effect(ProjectMemoryControl, make);
