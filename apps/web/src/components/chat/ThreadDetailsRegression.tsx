import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, QaRun, QaSuiteSummary, ThreadId } from "@t3tools/contracts";
import { PlayIcon, RepeatIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
} from "./threadDetailsPanelStyles";

const reportFailure = (title: string, error: unknown) =>
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    }),
  );

/** Starts a replay of a suite and says where its verdicts appear. */
export function useRunRegressionSuite(environmentId: EnvironmentId | null) {
  const run = useAtomCommand(serverEnvironment.runQaSuite, {
    label: "run regression suite",
    reportFailure: false,
  });
  return async (suite: QaSuiteSummary) => {
    if (environmentId === null) return;
    const result = await run({ environmentId, input: { suiteId: suite.suiteId } });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result))
        reportFailure("Could not run the suite", squashAtomCommandFailure(result));
      return;
    }
    toastManager.add({
      type: "success",
      title: `Replaying ${suite.name}`,
      description: "Its verdicts appear under Test run in the thread it was saved from.",
    });
  };
}

/** Saves a finished test run as a suite, saying which scenarios it left out. */
export function SaveRunAsRegression(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly run: QaRun;
}) {
  const canSave = useAtomValue(serverEnvironment.createQaSuite.permissionAtom(props.environmentId));
  const create = useAtomCommand(serverEnvironment.createQaSuite, {
    label: "save regression suite",
    reportFailure: false,
  });
  const [saving, setSaving] = useState(false);
  if (!canSave || props.run.finishedAt === null || props.run.kind === "regression") return null;
  const save = async () => {
    setSaving(true);
    const result = await create({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, runId: props.run.runId },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result))
        reportFailure("Could not save a regression suite", squashAtomCommandFailure(result));
      return;
    }
    const { suite, skipped } = result.value;
    toastManager.add({
      type: "success",
      title: `Saved ${suite.name}`,
      description:
        skipped.length === 0
          ? `${suite.scenarioCount} scenarios replay without a model.`
          : `${suite.scenarioCount} scenarios replay without a model. Left out: ${skipped
              .map((skip) => `${skip.scenario} (${skip.reason})`)
              .join("; ")}`,
    });
  };
  return (
    <ThreadDetailsControl
      size="xs"
      variant="ghost"
      part="meta"
      disabled={saving}
      onClick={() => void save()}
    >
      <RepeatIcon aria-hidden />
      {saving ? "Saving…" : "Save as regression"}
    </ThreadDetailsControl>
  );
}

/** The suites saved from this thread, each replayable without a model. */
export function ThreadDetailsRegression(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const suitesQuery = useEnvironmentQuery(
    serverEnvironment.qaSuitesLive({ environmentId: props.environmentId, input: {} }),
  );
  const canRun = useAtomValue(serverEnvironment.runQaSuite.permissionAtom(props.environmentId));
  const canDelete = useAtomValue(
    serverEnvironment.deleteQaSuite.permissionAtom(props.environmentId),
  );
  const runSuite = useRunRegressionSuite(props.environmentId);
  const deleteSuite = useAtomCommand(serverEnvironment.deleteQaSuite, {
    label: "delete regression suite",
    reportFailure: false,
  });
  const [confirmDelete, setConfirmDelete] = useState<QaSuiteSummary | null>(null);
  const suites = (suitesQuery.data?.suites ?? []).filter(
    (suite) => suite.sourceThreadId === props.threadId,
  );
  if (suites.length === 0) return null;

  const remove = async (suite: QaSuiteSummary) => {
    setConfirmDelete(null);
    const result = await deleteSuite({
      environmentId: props.environmentId,
      input: { suiteId: suite.suiteId },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
      reportFailure("Could not delete the suite", squashAtomCommandFailure(result));
  };

  return (
    <ThreadDetailsSection headingId="thread-details-regression-heading" title="Regression suites">
      <div className="flex flex-col">
        {suites.map((suite) => (
          <div
            key={suite.suiteId}
            className={cn(
              "flex min-h-8 items-center gap-1 py-1 text-xs",
              THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
            )}
          >
            <RepeatIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{suite.name}</span>
              <span className="text-2xs text-muted-foreground">
                {suite.scenarioCount} scenarios · {suite.stepCount} steps
              </span>
            </span>
            {canRun ? (
              <ThreadDetailsControl
                size="xs"
                variant="ghost"
                part="meta"
                onClick={() => void runSuite(suite)}
              >
                <PlayIcon aria-hidden />
                Run
              </ThreadDetailsControl>
            ) : null}
            {canDelete ? (
              <ThreadDetailsControl
                size="xs"
                variant="ghost"
                part="meta"
                aria-label={`Delete ${suite.name}`}
                onClick={() => setConfirmDelete(suite)}
              >
                <Trash2Icon aria-hidden />
              </ThreadDetailsControl>
            ) : null}
          </div>
        ))}
      </div>
      <AlertDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this regression suite?</AlertDialogTitle>
            <AlertDialogDescription>
              Its saved steps and checks are removed. Runs it already made stay under Test run.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => confirmDelete && void remove(confirmDelete)}
            >
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </ThreadDetailsSection>
  );
}
