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
  QaSavedSecret,
  QaSuite,
  QaSuiteSummary,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { T, Var, msg, useGT, useMessages } from "gt-react";
import { KeyRoundIcon, PlayIcon, RepeatIcon, SettingsIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { m, type MessageResolver } from "../../i18n/messages";
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
        reportFailure(gt("Could not run the suites"), squashAtomCommandFailure(result));
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

/** Saves a finished test run as a suite, saying which scenarios it left out. */
export function SaveRunAsRegression(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly run: QaRun;
}) {
  const gt = useGT();
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
        reportFailure(gt("Could not save a regression suite"), squashAtomCommandFailure(result));
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
  return (
    <ThreadDetailsControl
      size="xs"
      variant="ghost"
      part="meta"
      disabled={saving}
      onClick={() => void save()}
    >
      <RepeatIcon aria-hidden />
      {saving ? gt("Saving…") : gt("Save as regression")}
    </ThreadDetailsControl>
  );
}

const jobLabel = (job: QaRegressionJob, resolve: MessageResolver = m) =>
  job.dataRow === null
    ? job.suiteName
    : resolve(msg("{suite} · row {row}"), { suite: job.suiteName, row: job.dataRow.index + 1 });

const jobResult = (job: QaRegressionJob, resolve: MessageResolver = m) => {
  if (job.status === "queued") return resolve(msg("Queued"));
  if (job.status === "running") return resolve(msg("Running", { $context: "replay status" }));
  if (job.status === "failed") return job.error ?? resolve(msg("Could not start"));
  const counts = job.counts;
  if (counts === null) return resolve(msg("Done", { $context: "replay status" }));
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
  const messages = useMessages();
  return (
    <div
      className={cn("flex flex-col gap-0.5 pt-1.5 text-xs", THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS)}
    >
      <div className="text-2xs font-medium text-muted-foreground">
        <T>
          Last batch: <Var>{props.batch.label}</Var>
        </T>
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
          <span className="min-w-0 flex-1 truncate">{jobLabel(job, messages)}</span>
          <span
            className={cn(
              "shrink-0 text-2xs",
              job.status === "failed" || (job.counts?.fail ?? 0) > 0
                ? "text-destructive"
                : "text-muted-foreground",
            )}
          >
            {jobResult(job, messages)}
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
  const gt = useGT();
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
        reportFailure(gt("Could not apply the fix"), squashAtomCommandFailure(result));
      return;
    }
    if (accept)
      toastManager.add({
        type: "success",
        title: gt("Fix accepted"),
        description: gt("The suite is replaying with no AI to confirm it."),
      });
  };
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border/65 p-1.5 text-2xs">
      <span>
        <T>
          Proposed fix for step <Var>{props.proposal.stepIndex + 1}</Var>:{" "}
          <code className="break-all">
            <Var>{props.proposal.before.display}</Var>
          </code>{" "}
          →{" "}
          <code className="break-all">
            <Var>{props.proposal.after.display}</Var>
          </code>
        </T>
      </span>
      <span className="flex gap-1">
        <ThreadDetailsControl
          size="xs"
          variant="ghost"
          part="meta"
          onClick={() => void decide(true)}
        >
          <T>Accept and rerun</T>
        </ThreadDetailsControl>
        <ThreadDetailsControl
          size="xs"
          variant="ghost"
          part="meta"
          onClick={() => void decide(false)}
        >
          <T>Dismiss</T>
        </ThreadDetailsControl>
      </span>
    </div>
  );
}

/** The project's suites, replayable without a model, their last batch, and its saved passwords. */
export function ThreadDetailsRegression(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | null;
}) {
  const gt = useGT();
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
  const canForget = useAtomValue(
    serverEnvironment.forgetQaSavedSecret.permissionAtom(props.environmentId),
  );
  const forgetSecret = useAtomCommand(serverEnvironment.forgetQaSavedSecret, {
    label: "remove saved password",
    reportFailure: false,
  });
  const getSuite = useAtomCommand(serverEnvironment.getQaSuite, {
    label: "load regression suite",
    reportFailure: false,
  });
  const [confirmDelete, setConfirmDelete] = useState<QaSuiteSummary | null>(null);
  const [confirmForget, setConfirmForget] = useState<QaSavedSecret | null>(null);
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
  const savedSecrets = (suitesQuery.data?.savedSecrets ?? []).filter(
    (secret) => secret.projectId === props.projectId,
  );
  if (suites.length === 0 && savedSecrets.length === 0) return null;
  const batches = suitesQuery.data?.batches ?? [];
  const suiteIds = new Set(suites.map((suite) => suite.suiteId));
  const lastBatch = batches.find((batch) => batch.jobs.some((job) => suiteIds.has(job.suiteId)));
  const activeJobs = batches.flatMap((batch) =>
    batch.jobs.filter((job) => job.status === "queued" || job.status === "running"),
  );
  const statusOf = (suite: QaSuiteSummary) => {
    const jobs = activeJobs.filter((job) => job.suiteId === suite.suiteId);
    return jobs.some((job) => job.status === "running")
      ? gt("Running", { $context: "replay status" })
      : jobs.length > 0
        ? gt("Queued")
        : null;
  };
  const picked = suites.filter((suite) => selected.has(suite.suiteId));

  const forget = async (secret: QaSavedSecret) => {
    setConfirmForget(null);
    const result = await forgetSecret({
      environmentId: props.environmentId,
      input: { secretId: secret.secretId },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
      reportFailure(gt("Could not remove the saved password"), squashAtomCommandFailure(result));
  };

  const remove = async (suite: QaSuiteSummary) => {
    setConfirmDelete(null);
    const result = await deleteSuite({
      environmentId: props.environmentId,
      input: { suiteId: suite.suiteId },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
      reportFailure(gt("Could not delete the suite"), squashAtomCommandFailure(result));
  };
  const openSettings = async (suite: QaSuiteSummary) => {
    const result = await getSuite({
      environmentId: props.environmentId,
      input: { suiteId: suite.suiteId },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result))
        reportFailure(gt("Could not open the suite"), squashAtomCommandFailure(result));
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
    <ThreadDetailsSection
      headingId="thread-details-regression-heading"
      title={gt("Regression suites")}
    >
      <div className="flex flex-col">
        {canRun && suites.length > 0 ? (
          <div className="flex flex-wrap gap-1 px-1.5 pb-1">
            <ThreadDetailsControl
              size="xs"
              variant="ghost"
              part="meta"
              onClick={() =>
                void runSuites(
                  suites,
                  props.projectId === null ? gt("All suites") : gt("All in project"),
                )
              }
            >
              <PlayIcon aria-hidden />
              {props.projectId === null ? gt("Run all") : gt("Run all in project")}
            </ThreadDetailsControl>
            {picked.length > 0 ? (
              <ThreadDetailsControl
                size="xs"
                variant="ghost"
                part="meta"
                onClick={() => {
                  void runSuites(picked, gt("{count} selected", { count: picked.length }));
                  setSelected(new Set());
                }}
              >
                <T>
                  Run selected (<Var>{picked.length}</Var>)
                </T>
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
                    aria-label={gt("Select {name}", { name: suite.name })}
                  />
                ) : (
                  <RepeatIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
                )}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{suite.name}</span>
                  <span className="text-2xs text-muted-foreground">
                    {gt("{scenarios} scenarios · {steps} steps", {
                      scenarios: suite.scenarioCount,
                      steps: suite.stepCount,
                    })}
                    {suite.dataRowCount > 0
                      ? ` · ${gt("{count} rows", { count: suite.dataRowCount })}`
                      : ""}
                    {suite.healingEnabled ? ` · ${gt("healing on")}` : ""}
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
                    <T>Run</T>
                  </ThreadDetailsControl>
                ) : null}
                {canEdit ? (
                  <ThreadDetailsControl
                    size="xs"
                    variant="ghost"
                    part="meta"
                    aria-label={gt("Settings for {name}", { name: suite.name })}
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
                    aria-label={gt("Delete {name}", { name: suite.name })}
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
        {savedSecrets.map((secret) => (
          <div
            key={secret.secretId}
            className={cn(
              "flex min-h-8 items-center gap-1 py-1 text-xs",
              THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
            )}
          >
            <KeyRoundIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{secret.label}</span>
              <span className="truncate text-2xs text-muted-foreground">
                {secret.site === null
                  ? gt("Saved password")
                  : gt("Saved password · {host}", { host: new URL(secret.site).host })}
              </span>
            </span>
            {canForget ? (
              <ThreadDetailsControl
                size="xs"
                variant="ghost"
                part="meta"
                aria-label={gt("Remove saved password {label}", { label: secret.label })}
                onClick={() => setConfirmForget(secret)}
              >
                <Trash2Icon aria-hidden />
              </ThreadDetailsControl>
            ) : null}
          </div>
        ))}
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
        open={confirmForget !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmForget(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>Remove this saved password?</T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>
                Regression suites that sign in with it stop at that step until you save it again.
              </T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => confirmForget && void forget(confirmForget)}
            >
              <T>Remove</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>Delete this regression suite?</T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>
                Its saved steps, checks and baselines are removed. Runs it already made stay under
                Test run.
              </T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => confirmDelete && void remove(confirmDelete)}
            >
              <T>Delete</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </ThreadDetailsSection>
  );
}
