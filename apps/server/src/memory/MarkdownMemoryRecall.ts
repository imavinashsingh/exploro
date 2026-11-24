import {
  type ProjectId,
  ProjectMemoryError,
  MemoryGetGuideResult,
  MemorySearchInput,
  MemorySearchResult,
  MemoryForScreenInput,
  MemoryForScreenResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MarkdownMemoryStore from "./MarkdownMemoryStore.ts";
import * as ProjectMemory from "./ProjectMemory.ts";
import * as ProjectNavigationMemory from "./ProjectNavigationMemory.ts";
import { memoryEnvironment, memoryRoute } from "./projectMemoryFacts.ts";
import { normalizeMemoryEnvironment } from "./memoryEnvironment.ts";

export class MarkdownMemoryRecall extends Context.Service<
  MarkdownMemoryRecall,
  {
    readonly getGuide: (
      projectId: ProjectId,
      slug: string,
      environment?: string | null,
    ) => Effect.Effect<typeof MemoryGetGuideResult.Type, ProjectMemoryError>;
    readonly search: (
      projectId: ProjectId,
      input: typeof MemorySearchInput.Type,
    ) => Effect.Effect<typeof MemorySearchResult.Type, ProjectMemoryError>;
    readonly forScreen: (
      projectId: ProjectId,
      input: typeof MemoryForScreenInput.Type,
    ) => Effect.Effect<typeof MemoryForScreenResult.Type, ProjectMemoryError>;
  }
>()("t3/memory/MarkdownMemoryRecall") {}

const make = Effect.gen(function* () {
  const store = yield* MarkdownMemoryStore.MarkdownMemoryStore;
  const memory = yield* ProjectMemory.ProjectMemory;
  const navigation = yield* ProjectNavigationMemory.ProjectNavigationMemory;
  return MarkdownMemoryRecall.of({
    getGuide: Effect.fn("MarkdownMemoryRecall.getGuide")(function* (projectId, slug, environment) {
      yield* store.syncProject(projectId);
      return {
        guide:
          (yield* store.listDocs(
            projectId,
            normalizeMemoryEnvironment(environment) ?? undefined,
          )).find((doc) => doc.kind === "guide" && doc.slug === slug) ?? null,
      };
    }),
    search: Effect.fn("MarkdownMemoryRecall.search")(function* (projectId, input) {
      yield* store.syncProject(projectId);
      const environment = normalizeMemoryEnvironment(input.environment);
      const docs = yield* store.searchDocs(
        projectId,
        input.query,
        environment === null ? {} : { environment },
      );
      const facts = yield* memory.lookupFacts(projectId, {
        ...input,
        environment: environment ?? undefined,
        excludeVerdicts: true,
        limit: 40,
      });
      const matchedCount = docs.length + facts.length;
      return {
        docs,
        facts,
        appliedEnvironment: environment,
        matchedCount,
        ...(matchedCount === 0
          ? {
              diagnosticNote:
                environment === null
                  ? "No matching project memory."
                  : "No matching memory in this environment or unscoped memory; other environments are excluded.",
            }
          : {}),
      };
    }),
    forScreen: Effect.fn("MarkdownMemoryRecall.forScreen")(function* (projectId, input) {
      yield* store.syncProject(projectId);
      const environment =
        normalizeMemoryEnvironment(
          input.environment === undefined ? memoryEnvironment(input.route) : input.environment,
        ) ?? undefined;
      const route = memoryRoute(input.route);
      const guides = (yield* store.matchDocsByRoutes(projectId, [route], environment)).filter(
        (doc) => doc.kind === "guide",
      );
      const lookup = { route, ...(environment === undefined ? {} : { environment }), limit: 60 };
      const facts = yield* memory.lookupFacts(projectId, { ...lookup, excludeVerdicts: true });
      const openIssues = yield* memory.lookupFacts(projectId, { ...lookup, openFailures: true });
      const connections = yield* navigation.outgoingForScreen(projectId, route, environment);
      const matchedCount = guides.length + facts.length + openIssues.length + connections.length;
      return {
        appliedEnvironment: environment ?? null,
        matchedCount,
        ...(matchedCount === 0
          ? {
              diagnosticNote:
                environment === undefined
                  ? "No matching project memory."
                  : "No matching memory in this environment or unscoped memory; other environments are excluded.",
            }
          : {}),
        guides,
        facts,
        connections,
        openIssuesLabel: "Open issues from recent runs" as const,
        openIssues,
      };
    }),
  });
});
export const layer = Layer.effect(MarkdownMemoryRecall, make);
