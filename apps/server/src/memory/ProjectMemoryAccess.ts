import {
  PROJECT_CONTEXT_KINDS,
  type ProjectId,
  type ProjectUnderstandingKind,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as QaSavedSecrets from "../qa/QaSavedSecrets.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import { formatMemoryBrief, formatProjectContext, memoryTarget } from "./memoryBrief.ts";
import { seenNotTestedPages } from "./projectMap.ts";
import * as ProjectMemory from "./ProjectMemory.ts";
import * as ProjectUnderstanding from "./ProjectUnderstanding.ts";

/** How agent turns reach project memory. Both calls succeed, so memory never blocks a turn. */
export class ProjectMemoryAccess extends Context.Service<
  ProjectMemoryAccess,
  {
    /** Scratch threads have no project, and the user can turn memory off for a project. */
    readonly hasMemory: (projectId: ProjectId) => Effect.Effect<boolean>;
    /** The brief for a thread's first turn, or "" when memory has nothing or fails. */
    readonly firstTurnBrief: (
      projectId: ProjectId,
      goal: string,
      threadId?: ThreadId,
    ) => Effect.Effect<string>;
  }
>()("t3/memory/ProjectMemoryAccess") {}

export const memoryEnabled = (settings: ServerSettings, projectId: ProjectId) =>
  resolveProjectSettings(settings, projectId).settings.qaMemoryEnabled;

const CONTEXT_KINDS = new Set<ProjectUnderstandingKind>(PROJECT_CONTEXT_KINDS);

const make = Effect.gen(function* () {
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const serverSettings = yield* ServerSettingsService.ServerSettingsService;
  const memory = yield* ProjectMemory.ProjectMemory;
  const understanding = yield* ProjectUnderstanding.ProjectUnderstanding;
  const savedSecrets = yield* QaSavedSecrets.QaSavedSecrets;

  // Sites and saved passwords are the user's setup, so they come even with memory off.
  const projectContext = Effect.fn("ProjectMemoryAccess.projectContext")(
    function* (projectId: ProjectId, withMemory: boolean) {
      const settings = yield* serverSettings.getSettings;
      const sites = resolveProjectSettings(settings, projectId).settings.qaSiteOrigins;
      const savedPasswords = (yield* savedSecrets.list).filter(
        (saved) => saved.projectId === projectId,
      );
      const items = withMemory ? yield* understanding.contextItems(projectId) : [];
      return formatProjectContext({ sites, savedPasswords, items });
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Project context was not built", { cause }).pipe(Effect.as("")),
    ),
  );

  const hasMemory = Effect.fn("ProjectMemoryAccess.hasMemory")(function* (projectId: ProjectId) {
    if (yield* folders.isScratchProject(projectId)) return false;
    return yield* serverSettings.getSettings.pipe(
      Effect.map((settings) => memoryEnabled(settings, projectId)),
      Effect.orElseSucceed(() => true),
    );
  });

  return ProjectMemoryAccess.of({
    hasMemory,
    firstTurnBrief: Effect.fn("ProjectMemoryAccess.firstTurnBrief")(
      function* (projectId, goal, threadId) {
        if (yield* folders.isScratchProject(projectId)) return "";
        const withMemory = yield* hasMemory(projectId);
        const context = yield* projectContext(projectId, withMemory);
        if (!withMemory) return context;
        const navigationNote =
          "Project Navigation Memory is enabled. Ask navigation_route for the requested feature first; open its directUrl or follow its steps, verifying live. If it returns anything other than found, call navigation_observe on the current screen, then after each step you explore, including the destination.";
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
          const learned = recalled.items.filter(({ item }) => !CONTEXT_KINDS.has(item.kind));
          const untested = seenNotTestedPages(yield* memory.map(projectId)).filter(
            (page) => target.environment === null || page.environment === target.environment,
          );
          const brief = formatMemoryBrief({
            facts: facts.flat(),
            openFailures,
            understanding: learned,
            untested,
          });
          if (threadId !== undefined) {
            const recorded = [context, brief].filter(Boolean).join("\n\n");
            yield* memory.recordBriefUsage(threadId, recorded).pipe(Effect.ignore);
          }
          return [context, navigationNote, brief].filter(Boolean).join("\n\n");
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Project memory brief was not built", { projectId, cause }).pipe(
              Effect.as([context, navigationNote].filter(Boolean).join("\n\n")),
            ),
          ),
        );
      },
    ),
  });
});

export const layer = Layer.effect(ProjectMemoryAccess, make);
