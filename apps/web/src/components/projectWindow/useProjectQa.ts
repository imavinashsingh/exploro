import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  ProjectId,
  QaRun,
  ScopedProjectRef,
  ThreadId,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { useThreadShellsForProjectRefs } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

const EMPTY_RUNS: ReadonlyArray<QaRun> = [];
const EMPTY_PROJECT_REFS: ReadonlyArray<ScopedProjectRef> = [];

/** Every run of the given threads, keyed by their ids so an equal list reuses the atom. */
const threadRunsAtom = Atom.family((key: string) => {
  const [environmentId, ...threadIds] = key.split("\n") as [EnvironmentId, ...ThreadId[]];
  return Atom.make((get) =>
    threadIds.flatMap(
      (threadId) =>
        AsyncResult.getOrElse(
          get(serverEnvironment.qaRunsLive({ environmentId, input: { threadId } })),
          () => null,
        )?.runs ?? EMPTY_RUNS,
    ),
  ).pipe(Atom.withLabel(`project-window:runs:${key}`));
});

/**
 * The project's suites, saved passwords and batches. A thread with no project sees only the
 * suites it recorded, as the thread panel always did.
 */
export function useProjectQa(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
  threadId: ThreadId,
) {
  const query = useEnvironmentQuery(serverEnvironment.qaSuitesLive({ environmentId, input: {} }));
  const suites = (query.data?.suites ?? []).filter((suite) =>
    projectId === null
      ? suite.sourceThreadId === threadId
      : suite.projectId === projectId || suite.sourceThreadId === threadId,
  );
  const suiteIds = new Set(suites.map((suite) => suite.suiteId));
  const batches = (query.data?.batches ?? []).filter((batch) =>
    batch.jobs.some((job) => suiteIds.has(job.suiteId)),
  );
  const savedSecrets = (query.data?.savedSecrets ?? []).filter(
    (secret) => secret.projectId === projectId,
  );
  return { suites, batches, savedSecrets, error: query.error, isPending: query.isPending };
}

/** How many of the project's most recently updated threads the Runs tab and map read. */
const RECENT_THREAD_LIMIT = 15;

/**
 * Runs from this thread, the project's recently updated threads, each suite's own thread, and
 * the threads its replays ran in, with each thread's title.
 */
export function useProjectRuns(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
  threadId: ThreadId,
  qa: ReturnType<typeof useProjectQa>,
) {
  const shells = useThreadShellsForProjectRefs(
    projectId === null ? EMPTY_PROJECT_REFS : [scopeProjectRef(environmentId, projectId)],
  );
  const threadIds = new Set<string>([threadId]);
  for (const shell of shells
    .filter((shell) => shell.archivedAt === null)
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, RECENT_THREAD_LIMIT))
    threadIds.add(shell.id);
  const suiteIds = new Set<string>();
  for (const suite of qa.suites) {
    threadIds.add(suite.sourceThreadId);
    suiteIds.add(suite.suiteId);
  }
  for (const batch of qa.batches)
    for (const job of batch.jobs) if (suiteIds.has(job.suiteId)) threadIds.add(job.threadId);
  const runs = useAtomValue(
    threadRunsAtom([environmentId, ...[...threadIds].toSorted()].join("\n")),
  );
  const titles = new Map<string, string>(shells.map((shell) => [shell.id, shell.title]));
  return { runs, titles };
}
