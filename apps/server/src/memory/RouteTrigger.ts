import type { MemoryDoc, ProjectMemoryFact, ThreadId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as MarkdownMemoryRecall from "./MarkdownMemoryRecall.ts";
import { MEMORY_DATA_NOTE } from "./memoryBrief.ts";
import { memoryRoute } from "./projectMemoryFacts.ts";

/**
 * Appends the guides and open issues for the page a browser tool landed on, once per thread and
 * screen, so agents get route memory without asking and without a dump on every click.
 */
export class RouteTrigger extends Context.Service<
  RouteTrigger,
  {
    /** A short note for the tool result, or null when nothing new matches. Never fails. */
    readonly onPage: (threadId: ThreadId, url: string | null) => Effect.Effect<string | null>;
  }
>()("t3/memory/RouteTrigger") {}

const MAX_GUIDES = 3;
const MAX_ISSUES = 3;
// Threads are long-lived; forgetting the oldest only means one guide may be shown again.
const MAX_THREADS = 500;

const cut = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)}…`);
const quote = (text: string) => JSON.stringify(text);

const routeTriggerKey = (id: string, route: string) => `${id} ${route}`;

function formatRouteTriggerNote(
  route: string,
  guides: ReadonlyArray<MemoryDoc>,
  openIssues: ReadonlyArray<ProjectMemoryFact>,
): string | null {
  if (guides.length === 0 && openIssues.length === 0) return null;
  return [
    `Project memory for ${route}. ${MEMORY_DATA_NOTE}`,
    ...(guides.length === 0
      ? []
      : [
          "Guides (memory_get_guide reads one in full):",
          ...guides
            .slice(0, MAX_GUIDES)
            .map(
              (doc) =>
                `- ${quote(cut(doc.title, 120))} slug ${doc.slug}, ${doc.status}${doc.summary === "" ? "" : `: ${quote(cut(doc.summary, 200))}`}`,
            ),
        ]),
    ...(openIssues.length === 0
      ? []
      : [
          "Open issues from recent runs, not rules (re-check them; they may be fixed):",
          ...openIssues
            .slice(0, MAX_ISSUES)
            .map(
              (fact) =>
                `- ${fact.stateName}: ${quote(cut(fact.key, 120))} (${fact.observedAt.slice(0, 10)}, id ${fact.factId})`,
            ),
        ]),
  ].join("\n");
}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const settings = yield* ServerSettings.ServerSettingsService;
  const recall = yield* MarkdownMemoryRecall.MarkdownMemoryRecall;
  const seen = new Map<ThreadId, { route: string | null; shown: Set<string> }>();

  const seenFor = (threadId: ThreadId) => {
    const existing = seen.get(threadId);
    if (existing !== undefined) {
      seen.delete(threadId);
      seen.set(threadId, existing);
      return existing;
    }
    const created = { route: null, shown: new Set<string>() };
    seen.set(threadId, created);
    if (seen.size > MAX_THREADS) seen.delete(seen.keys().next().value!);
    return created;
  };

  const onPage = Effect.fn("RouteTrigger.onPage")(
    function* (threadId: ThreadId, url: string | null) {
      if (url === null || !URL.canParse(url)) return null;
      const page = new URL(url);
      if (page.protocol !== "https:" && page.protocol !== "http:") return null;
      const thread = yield* threads.getThreadShell(threadId);
      if (thread === null || (yield* folders.isScratchProject(thread.projectId))) return null;
      const current = resolveProjectSettings(
        yield* settings.getSettings,
        thread.projectId,
      ).settings;
      if (!current.qaMemoryEnabled) return null;
      // Sign-in or payment pages of other sites have no memory worth showing here.
      if (current.qaSiteOrigins.length > 0 && !current.qaSiteOrigins.includes(page.origin))
        return null;
      const route = `${page.origin}${memoryRoute(url)}`;
      const visit = seenFor(threadId);
      // Clicks within one screen skip the lookup (and its file scan) entirely.
      if (visit.route === route) return null;
      visit.route = route;
      const shown = visit.shown;
      const screen = yield* recall.forScreen(thread.projectId, { route: url });
      const guides = screen.guides.filter((doc) => !shown.has(routeTriggerKey(doc.docId, route)));
      const openIssues = screen.openIssues.filter(
        (fact) => !shown.has(routeTriggerKey(fact.factId, route)),
      );
      const note = formatRouteTriggerNote(route, guides, openIssues);
      // Only what the note showed counts as shown; the rest may appear on a later visit.
      for (const doc of guides.slice(0, MAX_GUIDES)) shown.add(routeTriggerKey(doc.docId, route));
      for (const fact of openIssues.slice(0, MAX_ISSUES))
        shown.add(routeTriggerKey(fact.factId, route));
      return note;
    },
    Effect.catchCause((cause) =>
      Effect.logDebug("Route memory was not attached", { cause }).pipe(Effect.as(null)),
    ),
  );

  return RouteTrigger.of({ onPage });
});

export const layer = Layer.effect(RouteTrigger, make);
