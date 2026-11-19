import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectId,
  QaHealProposal,
  QaRun,
  QaSuite,
  QaSuiteSummary,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { T, Var, useGT } from "gt-react";
import {
  ExternalLinkIcon,
  MoreHorizontalIcon,
  PlayIcon,
  SettingsIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { RegressionSuiteSettingsDialog } from "../chat/RegressionSuiteSettingsDialog";
import { reportQaFailure, useRunRegressionSuites } from "../chat/ThreadDetailsRegression";
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
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { suiteLastReplay, type SuiteLastReplay } from "./projectSuites.logic";
import type { useProjectQa } from "./useProjectQa";

function SuiteStatus(props: { readonly job: SuiteLastReplay | null; readonly proposals: number }) {
  const gt = useGT();
  const { job } = props;
  if (props.proposals > 0)
    return (
      <span className="text-destructive">
        {gt("{count, plural, one {{count} fix to review} other {{count} fixes to review}}", {
          count: props.proposals,
        })}
      </span>
    );
  if (job === null) return <T>Not run yet</T>;
  if (job.status === "queued") return gt("Queued");
  if (job.status === "running") return gt("Running…", { $context: "replay status" });
  if (job.status === "failed")
    return <span className="text-destructive">{job.error ?? gt("Could not start")}</span>;
  const counts = job.counts;
  if (counts === null) return gt("Done", { $context: "replay status" });
  if (counts.fail > 0)
    return (
      <span className="text-destructive">
        <T>
          Failed · FAIL <Var>{counts.fail}</Var>
        </T>
      </span>
    );
  return (
    <span className="text-success-foreground">
      <T>
        Passed · PASS <Var>{counts.pass}</Var>
      </T>
    </span>
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
        reportQaFailure(gt("Could not apply the fix"), squashAtomCommandFailure(result));
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
    <div className="flex flex-col gap-1 rounded-md border border-border/65 p-2 text-xs">
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
        <Button size="micro" variant="outline" onClick={() => void decide(true)}>
          <T>Accept and rerun</T>
        </Button>
        <Button size="micro" variant="ghost" onClick={() => void decide(false)}>
          <T>Dismiss</T>
        </Button>
      </span>
    </div>
  );
}

/** The project's suites: run them all, run one, or manage one from its menu. */
export function ProjectSuitesTab(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly qa: ReturnType<typeof useProjectQa>;
  readonly runs: ReadonlyArray<QaRun>;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const { suites, batches } = props.qa;
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
  const [openProposals, setOpenProposals] = useState<string | null>(null);

  if (suites.length === 0)
    return (
      <p className="m-0 px-3 py-6 text-center text-xs text-muted-foreground">
        <T>
          No regression suites yet. After a test run, choose Save as regression to replay it here
          without a model.
        </T>
      </p>
    );

  const remove = async (suite: QaSuiteSummary) => {
    setConfirmDelete(null);
    const result = await deleteSuite({
      environmentId: props.environmentId,
      input: { suiteId: suite.suiteId },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
      reportQaFailure(gt("Could not delete the suite"), squashAtomCommandFailure(result));
  };
  const openSettings = async (suite: QaSuiteSummary) => {
    const result = await getSuite({
      environmentId: props.environmentId,
      input: { suiteId: suite.suiteId },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result))
        reportQaFailure(gt("Could not open the suite"), squashAtomCommandFailure(result));
      return;
    }
    setEditing(result.value);
  };

  return (
    <div className="flex flex-col gap-2 p-3">
      {canRun ? (
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          onClick={() =>
            void runSuites(
              suites,
              props.projectId === null ? gt("All suites") : gt("All in project"),
            )
          }
        >
          <PlayIcon aria-hidden />
          <T>Run all</T>
        </Button>
      ) : null}
      <ul className="m-0 flex list-none flex-col p-0">
        {suites.map((suite) => {
          const job = suiteLastReplay(suite, batches, props.runs);
          const busy = job?.status === "queued" || job?.status === "running";
          const showProposals =
            canEdit && suite.proposals.length > 0 && openProposals === suite.suiteId;
          return (
            <li
              key={suite.suiteId}
              className="flex flex-col gap-1.5 border-b border-border/65 py-2 last:border-b-0"
            >
              <div className="flex min-w-0 items-center gap-1.5">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 flex-col text-start"
                  disabled={suite.proposals.length === 0}
                  aria-expanded={suite.proposals.length > 0 ? showProposals : undefined}
                  onClick={() => setOpenProposals(showProposals ? null : suite.suiteId)}
                >
                  <span className="truncate text-sm">{suite.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    <SuiteStatus job={job} proposals={canEdit ? suite.proposals.length : 0} />
                  </span>
                </button>
                {canRun ? (
                  <Button
                    size="compact"
                    variant="outline"
                    disabled={busy}
                    aria-label={gt("Run {name}", { name: suite.name })}
                    onClick={() => void runSuites([suite])}
                  >
                    <T>Run</T>
                  </Button>
                ) : null}
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={gt("More actions for {name}", { name: suite.name })}
                      />
                    }
                  >
                    <MoreHorizontalIcon aria-hidden />
                  </MenuTrigger>
                  <MenuPopup align="end" side="bottom" sideOffset={4}>
                    {canEdit ? (
                      <MenuItem onClick={() => void openSettings(suite)}>
                        <SettingsIcon className="size-3.5" />
                        <T>Settings</T>
                      </MenuItem>
                    ) : null}
                    {job !== null ? (
                      <MenuItem
                        onClick={() =>
                          void navigate({
                            to: "/$environmentId/$threadId",
                            params: { environmentId: props.environmentId, threadId: job.threadId },
                          })
                        }
                      >
                        <ExternalLinkIcon className="size-3.5" />
                        <T>Open last replay</T>
                      </MenuItem>
                    ) : null}
                    {canDelete ? (
                      <MenuItem variant="destructive" onClick={() => setConfirmDelete(suite)}>
                        <Trash2Icon className="size-3.5" />
                        <T>Delete</T>
                      </MenuItem>
                    ) : null}
                  </MenuPopup>
                </Menu>
              </div>
              {showProposals
                ? suite.proposals.map((proposal) => (
                    <ProposalRow
                      key={proposal.stepIndex}
                      environmentId={props.environmentId}
                      suite={suite}
                      proposal={proposal}
                    />
                  ))
                : null}
            </li>
          );
        })}
      </ul>
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
    </div>
  );
}
