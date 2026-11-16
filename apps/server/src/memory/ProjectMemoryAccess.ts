import type { ProjectId, ServerSettings } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import { formatMemoryBrief, memoryTarget } from "./memoryBrief.ts";
import * as ProjectMemory from "./ProjectMemory.ts";
import * as ProjectUnderstanding from "./ProjectUnderstanding.ts";

/** How agent turns reach project memory. Both calls succeed, so memory never blocks a turn. */
export class ProjectMemoryAccess extends Context.Service<
  ProjectMemoryAccess,
  {
    /** Scratch threads have no project, and the user can turn memory off for a project. */
    readonly hasMemory: (projectId: ProjectId) => Effect.Effect<boolean>;
    /** The brief for a thread's first turn, or "" when memory has nothing or fails. */
    readonly firstTurnBrief: (projectId: ProjectId, goal: string) => Effect.Effect<string>;
  }
>()("t3/memory/ProjectMemoryAccess") {}

export const memoryEnabled = (settings: ServerSettings, projectId: ProjectId) =>
  resolveProjectSettings(settings, projectId).settings.qaMemoryEnabled;

const make = Effect.gen(function* () {
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const serverSettings = yield* ServerSettingsService.ServerSettingsService;
  const memory = yield* ProjectMemory.ProjectMemory;
  const understanding = yield* ProjectUnderstanding.ProjectUnderstanding;

  const hasMemory = Effect.fn("ProjectMemoryAccess.hasMemory")(function* (projectId: ProjectId) {
    if (yield* folders.isScratchProject(projectId)) return false;
    return yield* serverSettings.getSettings.pipe(
      Effect.map((settings) => memoryEnabled(settings, projectId)),
      Effect.orElseSucceed(() => true),
    );
  });

  return ProjectMemoryAccess.of({
    hasMemory,
    firstTurnBrief: Effect.fn("ProjectMemoryAccess.firstTurnBrief")(function* (projectId, goal) {
      if (!(yield* hasMemory(projectId))) return "";
      return yield* Effect.gen(function* () {
        const known = yield* memory.lookupFacts(projectId, { limit: 500 });
        const target = memoryTarget(goal, known);
        const testing =
          target.environment === null ? {} : { testing: { environment: target.environment } };
        const facts = yield* Effect.forEach(target.routes, (route) =>
          memory.lookupFacts(projectId, {
            ...(target.environment === null ? {} : { environment: target.environment }),
            route,
            limit: 40,
            ...testing,
          }),
        );
        const openFailures = yield* memory.lookupFacts(projectId, {
          ...(target.environment === null ? {} : { environment: target.environment }),
          openFailures: true,
          limit: 15,
          ...testing,
        });
        const recalled = yield* understanding.recall(projectId, goal, { limit: 8 });
        return formatMemoryBrief({
          facts: facts.flat(),
          openFailures,
          understanding: recalled.items,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Project memory brief was not built", { projectId, cause }).pipe(
            Effect.as(""),
          ),
        ),
      );
    }),
  });
});

export const layer = Layer.effect(ProjectMemoryAccess, make);
