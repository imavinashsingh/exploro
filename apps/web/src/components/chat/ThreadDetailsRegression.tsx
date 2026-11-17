import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectId,
  QaHealProposal,
  QaRegressionBatch,
  QaRegressionJob,
  QaRun,
  QaSuite,
  QaSuiteSummary,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { PlayIcon, RepeatIcon, SettingsIcon, Trash2Icon } from "lucide-react";
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
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { RegressionSuiteSettingsDialog } from "./RegressionSuiteSettingsDialog";
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

/** Queues replays of the suites and says where their verdicts appear. */
export function useRunRegressionSuites(environmentId: EnvironmentId | null) {
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
        reportFailure("Could not run the suites", squashAtomCommandFailure(result));
      return;
    }
    toastManager.add({
      type: "success",
      title:
        suites.length === 1 ? `Replaying ${suites[0]!.name}` : `Replaying ${suites.length} suites`,
      description: "Verdicts appear under Test run in each suite's thread.",
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

const jobLabel = (job: QaRegressionJob) =>
  job.dataRow === null ? job.suiteName : `${job.suiteName} · row ${job.dataRow.index + 1}`;

const jobResult = (job: QaRegressionJob) => {
  if (job.status === "queued") return "Queued";
  if (job.status === "running") return "Running";
  if (job.status === "failed") return job.error ?? "Could not start";
  const counts = job.counts;
  if (counts === null) return "Done";
  return [
    counts.pass > 0 ? `PASS ${counts.pass}` : null,
    counts.fail > 0 ? `FAIL ${counts.fail}` : null,
    counts.inconclusive > 0 ? `INCONCLUSIVE ${counts.inconclusive}` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
};

/** One summary for a batch, linking each replay to the thread that holds its verdicts. */
function BatchSummary(props: {
  readonly environmentId: EnvironmentId;
  readonly batch: QaRegressionBatch;
}) {
  const navigate = useNavigate();
  return (
    <div
      className={cn("flex flex-col gap-0.5 pt-1.5 text-xs", THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS)}
    >
      <div className="text-2xs font-medium text-muted-foreground">
        Last batch: {props.batch.label}
      </div>
      {props.batch.jobs.map((job) => (
        <button
          key={job.jobId}
          type="button"
          className="flex min-w-0 items-center gap-2 py-0.5 text-start hover:underline"
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId: props.environmentId, threadId: job.threadId },
            })
          }
        >
          <span className="min-w-0 flex-1 truncate">{jobLabel(job)}</span>
          <span
            className={cn(
              "shrink-0 text-2xs",
              job.status === "failed" || (job.counts?.fail ?? 0) > 0
                ? "text-destructive"
                : "text-muted-foreground",
            )}
          >
            {jobResult(job)}
          </span>
        </button>
      ))}
    </div>
  );
}

function ProposalRow(props: {
  readonly environmentId: EnvironmentId;
  readonly suite: QaSuiteSummary;
  readonly proposal: QaHealProposal;
}) {
  const resolve = useAtomCommand(serverEnvironment.resolveQaHealProposal, {
    label: "resolve healing proposal",
    reportFailure: false,
  });
  const decide = async (accept: boolean) => {
    const result = await resolve({
      environmentId: props.environmentId,
      input: { suiteId: props.suite.suiteId, stepIndex: props.proposal.stepIndex, accept },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result))
        reportFailure("Could not apply the fix", squashAtomCommandFailure(result));
      return;
    }
    if (accept)
      toastManager.add({
        type: "success",
        title: "Fix accepted",
        description: "The suite is replaying with no AI to confirm it.",
      });
  };
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border/65 p-1.5 text-2xs">
      <span>
        Proposed fix for step {props.proposal.stepIndex + 1}:{" "}
        <code className="break-all">{props.proposal.before.display}</code> →{" "}
        <code className="break-all">{props.proposal.after.display}</code>
      </span>
      <span className="flex gap-1">
        <ThreadDetailsControl
          size="xs"
          variant="ghost"
          part="meta"
          onClick={() => void decide(true)}
        >
          Accept and rerun
        </ThreadDetailsControl>
        <ThreadDetailsControl
          size="xs"
          variant="ghost"
          part="meta"
          onClick={() => void decide(false)}
        >
          Dismiss
        </ThreadDetailsControl>
      </span>
    </div>
  );
}

/** The project's suites, each replayable without a model, and the last batch they ran in. */
export function ThreadDetailsRegression(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | null;
}) {
  const suitesQuery = useEnvironmentQuery(
    serverEnvironment.qaSuitesLive({ environmentId: props.environmentId, input: {} }),
  );
  const canRun = useAtomValue(serverEnvironment.runQaSuite.permissionAtom(props.environmentId));
  const canDelete = useAtomValue(
    serverEnvironment.deleteQaSuite.permissionAtom(props.environmentId),
  );
  const canEdit = useAtomValue(serverEnvironment.updateQaSuite.permissionAtom(props.environmentId));
  const runSuites = useRunRegressionSuites(props.environmentId);
  const deleteSuite = useAtomCommand(serverEnvironment.deleteQaSuite, {
    label: "delete regression suite",
    reportFailure: false,
  });
  const getSuite = useAtomCommand(serverEnvironment.getQaSuite, {
    label: "load regression suite",
    reportFailure: false,
  });
  const [confirmDelete, setConfirmDelete] = useState<QaSuiteSummary | null>(null);
  const [editing, setEditing] = useState<QaSuite | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const inScope = (suite: {
    readonly projectId: ProjectId | null;
    readonly sourceThreadId: ThreadId;
  }) =>
    props.projectId === null
      ? suite.sourceThreadId === props.threadId
      : suite.projectId === props.projectId || suite.sourceThreadId === props.threadId;
  const suites = (suitesQuery.data?.suites ?? []).filter(inScope);
  if (suites.length === 0) return null;
  const batches = suitesQuery.data?.batches ?? [];
  const suiteIds = new Set(suites.map((suite) => suite.suiteId));
  const lastBatch = batches.find((batch) => batch.jobs.some((job) => suiteIds.has(job.suiteId)));
  const activeJobs = batches.flatMap((batch) =>
    batch.jobs.filter((job) => job.status === "queued" || job.status === "running"),
  );
  const statusOf = (suite: QaSuiteSummary) => {
    const jobs = activeJobs.filter((job) => job.suiteId === suite.suiteId);
    return jobs.some((job) => job.status === "running")
      ? "Running"
      : jobs.length > 0
        ? "Queued"
        : null;
  };
  const picked = suites.filter((suite) => selected.has(suite.suiteId));

  const remove = async (suite: QaSuiteSummary) => {
    setConfirmDelete(null);
    const result = await deleteSuite({
      environmentId: props.environmentId,
      input: { suiteId: suite.suiteId },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
      reportFailure("Could not delete the suite", squashAtomCommandFailure(result));
  };
  const openSettings = async (suite: QaSuiteSummary) => {
    const result = await getSuite({
      environmentId: props.environmentId,
      input: { suiteId: suite.suiteId },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result))
        reportFailure("Could not open the suite", squashAtomCommandFailure(result));
      return;
    }
    setEditing(result.value);
  };
  const toggle = (suiteId: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(suiteId);
    else next.delete(suiteId);
    setSelected(next);
  };

  return (
    <ThreadDetailsSection headingId="thread-details-regression-heading" title="Regression suites">
      <div className="flex flex-col">
        {canRun ? (
          <div className="flex flex-wrap gap-1 px-1.5 pb-1">
            <ThreadDetailsControl
              size="xs"
              variant="ghost"
              part="meta"
              onClick={() =>
                void runSuites(suites, props.projectId === null ? "All suites" : "All in project")
              }
            >
              <PlayIcon aria-hidden />
              {props.projectId === null ? "Run all" : "Run all in project"}
            </ThreadDetailsControl>
            {picked.length > 0 ? (
              <ThreadDetailsControl
                size="xs"
                variant="ghost"
                part="meta"
                onClick={() => {
                  void runSuites(picked, `${picked.length} selected`);
                  setSelected(new Set());
                }}
              >
                Run selected ({picked.length})
              </ThreadDetailsControl>
            ) : null}
          </div>
        ) : null}
        {suites.map((suite) => {
          const status = statusOf(suite);
          return (
            <div
              key={suite.suiteId}
              className={cn("flex flex-col gap-1 py-1", THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS)}
            >
              <div className="flex min-h-7 items-center gap-1 text-xs">
                {canRun ? (
                  <Checkbox
                    checked={selected.has(suite.suiteId)}
                    onCheckedChange={(on) => toggle(suite.suiteId, on === true)}
                    aria-label={`Select ${suite.name}`}
                  />
                ) : (
                  <RepeatIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
                )}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{suite.name}</span>
                  <span className="text-2xs text-muted-foreground">
                    {suite.scenarioCount} scenarios · {suite.stepCount} steps
                    {suite.dataRowCount > 0 ? ` · ${suite.dataRowCount} rows` : ""}
                    {suite.healingEnabled ? " · healing on" : ""}
                  </span>
                </span>
                {status === null ? null : (
                  <Badge size="sm" variant="outline">
                    {status}
                  </Badge>
                )}
                {canRun ? (
                  <ThreadDetailsControl
                    size="xs"
                    variant="ghost"
                    part="meta"
                    onClick={() => void runSuites([suite])}
                  >
                    <PlayIcon aria-hidden />
                    Run
                  </ThreadDetailsControl>
                ) : null}
                {canEdit ? (
                  <ThreadDetailsControl
                    size="xs"
                    variant="ghost"
                    part="meta"
                    aria-label={`Settings for ${suite.name}`}
                    onClick={() => void openSettings(suite)}
                  >
                    <SettingsIcon aria-hidden />
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
              {canEdit
                ? suite.proposals.map((proposal) => (
                    <ProposalRow
                      key={proposal.stepIndex}
                      environmentId={props.environmentId}
                      suite={suite}
                      proposal={proposal}
                    />
                  ))
                : null}
            </div>
          );
        })}
        {lastBatch === undefined ? null : (
          <BatchSummary environmentId={props.environmentId} batch={lastBatch} />
        )}
      </div>
      {editing === null ? null : (
        <RegressionSuiteSettingsDialog
          environmentId={props.environmentId}
          suite={editing}
          onClose={() => setEditing(null)}
        />
      )}
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
              Its saved steps, checks and baselines are removed. Runs it already made stay under
              Test run.
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
