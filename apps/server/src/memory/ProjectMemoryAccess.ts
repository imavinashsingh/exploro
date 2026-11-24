import { type ProjectId, type ServerSettings, type ThreadId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as QaSavedSecrets from "../qa/QaSavedSecrets.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import {
  formatMarkdownMemoryBrief,
  formatProjectContext,
  memoryPromptTargets,
} from "./memoryBrief.ts";
import * as MarkdownMemoryStore from "./MarkdownMemoryStore.ts";
import * as ProjectMemory from "./ProjectMemory.ts";
import { memoryEnvironmentMatches, normalizeMemoryEnvironment } from "./memoryEnvironment.ts";

/** How agent turns reach project memory. Both calls succeed, so memory never blocks a turn. */
export class ProjectMemoryAccess extends Context.Service<
  ProjectMemoryAccess,
  {
    /** Scratch threads have no project, and the user can turn memory off for a project. */
    readonly hasMemory: (projectId: ProjectId) => Effect.Effect<boolean>;
    /** The brief at thread start or a recall refresh, or "" when memory has nothing or fails. */
    readonly firstTurnBrief: (
      projectId: ProjectId,
      goal: string,
      threadId?: ThreadId,
    ) => Effect.Effect<string>;
  }
>()("t3/memory/ProjectMemoryAccess") {}

export const memoryEnabled = (settings: ServerSettings, projectId: ProjectId) =>
  resolveProjectSettings(settings, projectId).settings.qaMemoryEnabled;

const make = Effect.gen(function* () {
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const serverSettings = yield* ServerSettingsService.ServerSettingsService;
  const memory = yield* ProjectMemory.ProjectMemory;
  const markdown = yield* MarkdownMemoryStore.MarkdownMemoryStore;
  const savedSecrets = yield* QaSavedSecrets.QaSavedSecrets;

  // Sites and saved passwords are the user's setup, so they come even with memory off.
  const projectContext = Effect.fn("ProjectMemoryAccess.projectContext")(
    function* (projectId: ProjectId) {
      const settings = yield* serverSettings.getSettings;
      const sites = resolveProjectSettings(settings, projectId).settings.qaSiteOrigins;
      const savedPasswords = (yield* savedSecrets.list).filter(
        (saved) => saved.projectId === projectId,
      );
      return formatProjectContext({ sites, savedPasswords, items: [] }, 700);
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
        const context = yield* projectContext(projectId);
        if (!withMemory) return context;
        return yield* Effect.gen(function* () {
          yield* markdown.syncProject(projectId);
          const targets = memoryPromptTargets(goal);
          const scopes = targets.flatMap((target) => {
            const environment = normalizeMemoryEnvironment(target.environment);
            return environment === null ? [] : [environment];
          });
          const docs = (yield* markdown.listDocs(projectId)).filter(
            (doc) =>
              scopes.length === 0 ||
              scopes.some((scope) => memoryEnvironmentMatches(scope, doc.environment)),
          );
          const routeMatches = yield* Effect.forEach(targets, (target) =>
            markdown.matchDocsByRoutes(projectId, target.routes, target.environment ?? undefined),
          );
          const environments = [
            ...new Set(
              targets
                .map((target) => target.environment)
                .filter((env): env is string => env !== null),
            ),
          ];
          const searches = yield* Effect.forEach(
            environments.length === 0 ? [undefined] : environments,
            (environment) =>
              markdown.searchDocs(projectId, goal, {
                ...(environment === undefined ? {} : { environment }),
                limit: 4,
              }),
          );
          const matches = [
            ...new Map(
              [
                ...routeMatches.flatMap((docs) => docs.slice(0, 1)),
                ...routeMatches.flat(),
                ...searches.flat(),
              ]
                .filter(
                  (doc) =>
                    scopes.length === 0 ||
                    scopes.some((scope) => memoryEnvironmentMatches(scope, doc.environment)),
                )
                .map((doc) => [doc.docId, doc]),
            ).values(),
          ];
          const brief = formatMarkdownMemoryBrief({ docs, matches, context });
          if (threadId !== undefined)
            yield* memory.recordBriefUsage(threadId, brief).pipe(Effect.ignore);
          return brief;
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Project memory brief was not built", { projectId, cause }).pipe(
              Effect.as(context),
            ),
          ),
        );
      },
    ),
  });
});

export const layer = Layer.effect(ProjectMemoryAccess, make);
