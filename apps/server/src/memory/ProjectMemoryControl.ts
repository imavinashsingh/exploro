import {
  ProjectMemoryError,
  type ProjectId,
  type ProjectMemorySnapshot,
  type ProjectUnderstandingItem,
  type ProjectUnderstandingVersion,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectMemory from "./ProjectMemory.ts";
import * as ProjectUnderstanding from "./ProjectUnderstanding.ts";
import * as UnderstandingExtraction from "./UnderstandingExtraction.ts";

const SNAPSHOT_FACT_LIMIT = 2000;

/** What the user does with a project's memory from the Memory screen. */
export class ProjectMemoryControl extends Context.Service<
  ProjectMemoryControl,
  {
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
  const understanding = yield* ProjectUnderstanding.ProjectUnderstanding;
  const extraction = yield* UnderstandingExtraction.UnderstandingExtraction;

  return ProjectMemoryControl.of({
    snapshot: Effect.fn("ProjectMemoryControl.snapshot")(function* (projectId) {
      const facts = yield* memory.listFacts(projectId, SNAPSHOT_FACT_LIMIT + 1);
      return {
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
