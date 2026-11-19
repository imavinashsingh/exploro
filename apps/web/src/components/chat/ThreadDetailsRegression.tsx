import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId, QaRun, QaSuiteSummary, ThreadId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { FolderKanbanIcon } from "lucide-react";

import { useRightPanelStore } from "../../rightPanelStore";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useProjectQa } from "../projectWindow/useProjectQa";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";

export const reportQaFailure = (title: string, error: unknown) =>
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    }),
  );

/** Queues replays of the suites and says where their verdicts appear. */
export function useRunRegressionSuites(environmentId: EnvironmentId | null) {
  const gt = useGT();
  const run = useAtomCommand(serverEnvironment.runQaSuite, {
    label: "run regression suites",
    reportFailure: false,
  });
  return async (suites: ReadonlyArray<QaSuiteSummary>, label?: string) => {
    if (environmentId === null || suites.length === 0) return;
    const result = await run({
      environmentId,
      input: {
        suiteIds: suites.map((suite) => suite.suiteId),
        ...(label === undefined ? {} : { label }),
      },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result))
        reportQaFailure(gt("Could not run the suites"), squashAtomCommandFailure(result));
      return;
    }
    toastManager.add({
      type: "success",
      title:
        suites.length === 1
          ? gt("Replaying {name}", { name: suites[0]!.name })
          : gt("Replaying {count} suites", { count: suites.length }),
      description: gt("Verdicts appear under Test run in each suite's thread."),
    });
  };
}

/** Saves a finished test run as a suite, saying which scenarios it left out; null when it can't. */
export function useSaveRunAsRegression(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  run: QaRun | null,
): (() => Promise<void>) | null {
  const gt = useGT();
  const canSave = useAtomValue(serverEnvironment.createQaSuite.permissionAtom(environmentId));
  const create = useAtomCommand(serverEnvironment.createQaSuite, {
    label: "save regression suite",
    reportFailure: false,
  });
  if (!canSave || run === null || run.finishedAt === null || run.kind === "regression") return null;
  return async () => {
    const result = await create({ environmentId, input: { threadId, runId: run.runId } });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result))
        reportQaFailure(gt("Could not save a regression suite"), squashAtomCommandFailure(result));
      return;
    }
    const { suite, skipped } = result.value;
    const replays = gt(
      "{count, plural, one {{count} scenario replays without a model.} other {{count} scenarios replay without a model.}}",
      { count: suite.scenarioCount },
    );
    const leftOut = skipped.map((skip) => `${skip.scenario} (${skip.reason})`).join("; ");
    toastManager.add({
      type: "success",
      title: gt("Saved {name}", { name: suite.name }),
      description:
        skipped.length === 0
          ? replays
          : `${replays} ${gt("Left out: {scenarios}", { scenarios: leftOut })}`,
    });
  };
}

/** The thread's way into the Project Window, where the project's suites live. */
export function ThreadDetailsRegression(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | null;
}) {
  const gt = useGT();
  const qa = useProjectQa(props.environmentId, props.projectId, props.threadId);
  if (qa.suites.length === 0 && qa.savedSecrets.length === 0) return null;
  const running = qa.batches.some((batch) =>
    batch.jobs.some((job) => job.status === "queued" || job.status === "running"),
  );
  return (
    <ThreadDetailsSection
      headingId="thread-details-regression-heading"
      title={gt("Regression suites")}
    >
      <div className="flex flex-col">
        <ThreadDetailsControl
          size="sm"
          variant="ghost"
          part="row"
          onClick={() =>
            useRightPanelStore
              .getState()
              .open(scopeThreadRef(props.environmentId, props.threadId), "project")
          }
        >
          <FolderKanbanIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          <span className="min-w-0 flex-1 truncate">
            {qa.suites.length === 0
              ? gt("No suites yet")
              : gt("{count, plural, one {{count} suite} other {{count} suites}}", {
                  count: qa.suites.length,
                })}
            {running ? ` · ${gt("Running", { $context: "replay status" })}` : ""}
          </span>
          <span className="shrink-0 text-2xs text-muted-foreground">
            <T>Open project window</T>
          </span>
        </ThreadDetailsControl>
      </div>
    </ThreadDetailsSection>
  );
}
