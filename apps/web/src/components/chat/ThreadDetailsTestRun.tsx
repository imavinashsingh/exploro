import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type QaRun,
  type QaScenario,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ClipboardCheckIcon,
  FileTextIcon,
  FolderOpenIcon,
  HistoryIcon,
  MoreHorizontalIcon,
  RepeatIcon,
  Trash2Icon,
} from "lucide-react";
import { T, Var, useGT } from "gt-react";
import { useState } from "react";

import { useAssetUrlState } from "../../assets/assetUrls";
import { cn } from "../../lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { shellEnvironment } from "../../state/shell";
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
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { useSaveRunAsRegression } from "./ThreadDetailsRegression";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
} from "./threadDetailsPanelStyles";
import {
  formatVideoOffset,
  runStartedLabel,
  VERDICT_BADGE_VARIANT,
  verdictSummary,
} from "./threadDetailsTestRun.logic";

interface ThreadDetailsTestRunProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

const reportFailure = (title: string, error: unknown) =>
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    }),
  );

function VerdictSummary(props: { readonly run: QaRun }) {
  const summary = verdictSummary(props.run);
  if (summary.length === 0)
    return (
      <span className="text-muted-foreground">
        <T>No verdicts yet</T>
      </span>
    );
  return (
    <span className="flex flex-wrap gap-1">
      {summary.map(({ verdict, count }) => (
        <Badge key={verdict} size="sm" variant={VERDICT_BADGE_VARIANT[verdict]}>
          {verdict} {count}
        </Badge>
      ))}
    </span>
  );
}

function EvidenceImage(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly path: string;
  readonly alt: string;
}) {
  const gt = useGT();
  const asset = useAssetUrlState(props.environmentId, {
    _tag: "media-file",
    threadId: props.threadRef.threadId,
    path: props.path,
  });
  const url = asset._tag === "Success" ? asset.url : null;
  return (
    <button
      type="button"
      className="block w-full overflow-hidden rounded-md border border-border/65"
      onClick={() => useRightPanelStore.getState().openFile(props.threadRef, props.path)}
      aria-label={gt("Open screenshot: {name}", { name: props.alt })}
    >
      {url ? (
        <img src={url} alt={props.alt} className="block w-full" loading="lazy" />
      ) : (
        <span className="block h-20 bg-muted/40" />
      )}
    </button>
  );
}

function EvidenceVideo(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly path: string;
  readonly offsetMs: number;
}) {
  const asset = useAssetUrlState(props.environmentId, {
    _tag: "media-file",
    threadId: props.threadId,
    path: props.path,
  });
  const url = asset._tag === "Success" ? asset.url : null;
  if (!url) return null;
  return (
    <video
      controls
      preload="metadata"
      className="w-full rounded-md border border-border/65"
      src={`${url}#t=${Math.floor(props.offsetMs / 1000)}`}
    />
  );
}

const percent = (ratio: number) => `${(ratio * 100).toFixed(2)}%`;

/** The replay's capture beside the suite's baseline, with the way to accept a new look. */
function VisualEvidence(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly run: QaRun;
  readonly scenario: QaScenario;
  readonly visual: NonNullable<QaScenario["visual"]>;
}) {
  const gt = useGT();
  const { visual } = props;
  const canAccept = useAtomValue(
    serverEnvironment.acceptQaBaseline.permissionAtom(props.environmentId),
  );
  const accept = useAtomCommand(serverEnvironment.acceptQaBaseline, {
    label: "accept regression baseline",
  });
  const [accepted, setAccepted] = useState(false);
  const differs = visual.diffRatio !== null && visual.diffRatio > visual.threshold;
  const images = [
    [gt("Baseline"), visual.baselinePath],
    [gt("Replay", { $context: "noun, a regression replay capture" }), visual.capturePath],
    [gt("Difference"), visual.diffPath],
  ].filter((image): image is [string, string] => image[1] !== null);
  const acceptBaseline = async () => {
    if (props.run.suiteId === null) return;
    const result = await accept({
      environmentId: props.environmentId,
      input: {
        suiteId: props.run.suiteId,
        threadId: props.threadRef.threadId,
        runId: props.run.runId,
        scenarioIndex: props.scenario.index,
      },
    });
    if (result._tag === "Success") setAccepted(true);
  };
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground">
        {visual.diffRatio === null
          ? gt("Visual: no baseline yet; this capture is now the baseline.")
          : gt("Visual: {diff} of pixels differ (allowed {threshold}).", {
              diff: percent(visual.diffRatio),
              threshold: percent(visual.threshold),
            })}
      </span>
      {visual.diffRatio === null ? null : (
        <div className="grid grid-cols-3 gap-1">
          {images.map(([label, path]) => (
            <div key={label} className="flex min-w-0 flex-col gap-0.5">
              <span className="text-2xs text-muted-foreground">{label}</span>
              <EvidenceImage
                environmentId={props.environmentId}
                threadRef={props.threadRef}
                path={path}
                alt={`${label}: ${props.scenario.scenario}`}
              />
            </div>
          ))}
        </div>
      )}
      {differs && canAccept && props.run.suiteId !== null ? (
        <ThreadDetailsControl
          size="xs"
          variant="ghost"
          part="meta"
          disabled={accepted}
          onClick={() => void acceptBaseline()}
        >
          {accepted ? gt("Accepted as new baseline") : gt("Accept as new baseline")}
        </ThreadDetailsControl>
      ) : null}
    </div>
  );
}

function ScenarioEvidence(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly run: QaRun;
  readonly scenario: QaScenario;
}) {
  const gt = useGT();
  const { scenario } = props;
  const facts = [
    scenario.severity ? [gt("Severity"), scenario.severity] : null,
    scenario.expected
      ? [gt("Expected", { $context: "expected result of a test" }), scenario.expected]
      : null,
    scenario.actual
      ? [gt("Actual", { $context: "actual result of a test" }), scenario.actual]
      : null,
    scenario.pageUrl ? [gt("Page", { $context: "web page" }), scenario.pageUrl] : null,
  ].filter((fact): fact is [string, string] => fact !== null);
  // Steps and requests can repeat, so their position is part of their identity.
  const steps = scenario.steps.map((step, position) => ({ id: `${position}:${step}`, step }));
  const requests = scenario.failedRequests.map((request, position) => ({
    id: `${position}:${request.method} ${request.url}`,
    request,
  }));
  return (
    <div className="flex flex-col gap-2 px-2.5 pt-1 pb-2 text-xs">
      {scenario.downgradeReason ? (
        <p className="m-0 text-warning-foreground">{scenario.downgradeReason}</p>
      ) : null}
      <p className="m-0 whitespace-pre-wrap text-foreground/85">{scenario.note}</p>
      {facts.length > 0 ? (
        <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-2 gap-y-0.5">
          {facts.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="m-0 min-w-0 break-words">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {scenario.steps.length > 0 ? (
        <div>
          <div className="mb-0.5 text-muted-foreground">
            <T>Steps to reproduce</T>
          </div>
          <ol className="m-0 list-decimal ps-4">
            {steps.map(({ id, step }) => (
              <li key={id}>{step}</li>
            ))}
          </ol>
        </div>
      ) : null}
      {scenario.screenshotPath ? (
        <EvidenceImage
          environmentId={props.environmentId}
          threadRef={props.threadRef}
          path={scenario.screenshotPath}
          alt={scenario.scenario}
        />
      ) : (
        <p className="m-0 text-muted-foreground">
          <T>No screenshot</T>
        </p>
      )}
      {scenario.visual ? (
        <VisualEvidence
          environmentId={props.environmentId}
          threadRef={props.threadRef}
          run={props.run}
          scenario={scenario}
          visual={scenario.visual}
        />
      ) : null}
      {props.run.video && scenario.videoOffsetMs !== null ? (
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground">
            <T>
              Video at <Var>{formatVideoOffset(scenario.videoOffsetMs)}</Var>
            </T>
          </span>
          <EvidenceVideo
            environmentId={props.environmentId}
            threadId={props.threadRef.threadId}
            path={props.run.video.path}
            offsetMs={scenario.videoOffsetMs}
          />
        </div>
      ) : null}
      <div>
        <div className="text-muted-foreground">
          <T>
            Console errors: <Var>{scenario.consoleErrorCount}</Var>
          </T>
        </div>
        {scenario.consoleErrors.length > 0 ? (
          <pre className="m-0 mt-0.5 max-h-32 overflow-auto rounded-md bg-muted/40 p-1.5 font-mono text-2xs whitespace-pre-wrap break-words">
            {scenario.consoleErrors.join("\n")}
          </pre>
        ) : null}
      </div>
      <div>
        <div className="text-muted-foreground">
          <T>
            Failed requests: <Var>{scenario.failedRequestCount}</Var>
          </T>
        </div>
        {scenario.failedRequests.length > 0 ? (
          <ul className="m-0 mt-0.5 list-none p-0 font-mono text-2xs">
            {requests.map(({ id, request }) => (
              <li key={id} className="break-all">
                {request.status ?? "ERR"} {request.method} {request.url}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {scenario.consolePath ? (
        <div className="flex gap-1">
          <ThreadDetailsControl
            size="xs"
            variant="ghost"
            part="meta"
            onClick={() =>
              useRightPanelStore.getState().openFile(props.threadRef, scenario.consolePath!)
            }
          >
            <T>Console log</T>
          </ThreadDetailsControl>
          {scenario.networkPath ? (
            <ThreadDetailsControl
              size="xs"
              variant="ghost"
              part="meta"
              onClick={() =>
                useRightPanelStore.getState().openFile(props.threadRef, scenario.networkPath!)
              }
            >
              <T>Network log</T>
            </ThreadDetailsControl>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The run's verdicts and evidence, with the reports and earlier runs of this thread. */
export function ThreadDetailsTestRun(props: ThreadDetailsTestRunProps) {
  const gt = useGT();
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const runsQuery = useEnvironmentQuery(
    serverEnvironment.qaRunsLive({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    }),
  );
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const canDelete = useAtomValue(serverEnvironment.deleteQaRun.permissionAtom(props.environmentId));
  const deleteRun = useAtomCommand(serverEnvironment.deleteQaRun, { label: "delete QA run" });
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<QaRun | null>(null);

  const runs = runsQuery.data?.runs ?? [];
  const run = runs.find((candidate) => candidate.runId === selectedRunId) ?? runs[0] ?? null;
  const earlierRuns = runs.filter((candidate) => candidate.runId !== run?.runId);
  const canOpenFolder = config?.availableEditors.includes("file-manager") === true;
  const bugs = run?.scenarios.filter((scenario) => scenario.verdict === "FAIL") ?? [];

  const openFolder = async (dir: string) => {
    if (!readEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope)) return;
    const result = await openInEditor({
      environmentId: props.environmentId,
      input: { cwd: dir, editor: "file-manager" },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure(gt("Could not open the evidence folder"), squashAtomCommandFailure(result));
    }
  };

  const removeRun = async (target: QaRun) => {
    setConfirmDelete(null);
    const result = await deleteRun({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, runId: target.runId },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure(gt("Could not delete the run"), squashAtomCommandFailure(result));
    } else if (target.runId === selectedRunId) {
      setSelectedRunId(null);
    }
  };

  const reportPath = run?.reportHtmlPath ?? run?.reportMarkdownPath ?? null;
  const saveAsRegression = useSaveRunAsRegression(props.environmentId, props.threadId, run);

  return (
    <ThreadDetailsSection
      headingId="thread-details-test-run-heading"
      title={gt("Test run")}
      data-thread-test-run-panel
    >
      <div className="flex flex-col">
        {run === null ? (
          <div className={cn(THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS, "flex items-center")}>
            <ClipboardCheckIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
            <span className="truncate text-muted-foreground">
              {runsQuery.error ?? gt("No verdicts yet")}
            </span>
          </div>
        ) : (
          <>
            <div
              className={cn(
                "flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1 py-1 text-xs",
                THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
              )}
            >
              <VerdictSummary run={run} />
              {run.kind === "regression" ? (
                <Badge size="sm" variant="outline">
                  <T>Regression</T>
                </Badge>
              ) : null}
              {run.dataRow === null ? null : (
                <>
                  <Badge size="sm" variant="outline">
                    <T>
                      Row <Var>{run.dataRow.index + 1}</Var>
                    </T>
                  </Badge>
                  <span className="min-w-0 truncate text-2xs text-muted-foreground">
                    {Object.entries(run.dataRow.values)
                      .map(([name, value]) => `${name}=${value}`)
                      .join(", ")}
                  </span>
                </>
              )}
              <span className="text-2xs text-muted-foreground">
                {run.finishedAt === null
                  ? gt("Running", { $context: "test run status" })
                  : runStartedLabel(run)}
              </span>
            </div>

            {run.scenarios.map((scenario) => {
              const open = expanded === scenario.index;
              return (
                <div key={scenario.index}>
                  <ThreadDetailsControl
                    size="sm"
                    variant="ghost"
                    part="row"
                    multiline
                    aria-expanded={open}
                    onClick={() => setExpanded(open ? null : scenario.index)}
                  >
                    {open ? (
                      <ChevronDownIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
                    ) : (
                      <ChevronRightIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
                    )}
                    <span className="min-w-0 flex-1 truncate">{scenario.scenario}</span>
                    <span className="shrink-0">
                      <Badge size="sm" variant={VERDICT_BADGE_VARIANT[scenario.verdict]}>
                        {scenario.verdict}
                      </Badge>
                    </span>
                  </ThreadDetailsControl>
                  {open ? (
                    <ScenarioEvidence
                      environmentId={props.environmentId}
                      threadRef={threadRef}
                      run={run}
                      scenario={scenario}
                    />
                  ) : null}
                </div>
              );
            })}

            {bugs.length > 0 ? (
              <div className={cn("pt-1.5 text-xs", THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS)}>
                <div className="mb-0.5 text-2xs font-medium text-muted-foreground">
                  <T>
                    Bugs (<Var>{bugs.length}</Var>)
                  </T>
                </div>
                <ul className="m-0 list-none p-0">
                  {bugs.map((bug) => (
                    <li key={bug.index}>
                      <button
                        type="button"
                        className="w-full truncate py-0.5 text-start text-foreground/85 hover:underline"
                        onClick={() => setExpanded(bug.index)}
                      >
                        {bug.severity ? `[${bug.severity}] ` : ""}
                        {bug.scenario}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {run.video === null && run.videoUnavailableReason ? (
              <p
                className={cn(
                  "m-0 py-1 text-2xs text-muted-foreground",
                  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
                )}
              >
                <T>
                  Video unavailable: <Var>{run.videoUnavailableReason}</Var>
                </T>
              </p>
            ) : null}

            <div className="flex flex-wrap items-center gap-1 px-1.5 pt-1">
              {reportPath ? (
                <ThreadDetailsControl
                  size="xs"
                  variant="ghost"
                  part="meta"
                  onClick={() => useRightPanelStore.getState().openFile(threadRef, reportPath)}
                >
                  <FileTextIcon aria-hidden />
                  <T>Report</T>
                </ThreadDetailsControl>
              ) : null}
              <Menu>
                <MenuTrigger
                  render={
                    <ThreadDetailsControl
                      size="xs"
                      variant="ghost"
                      part="meta"
                      aria-label={gt("More actions for this run")}
                    />
                  }
                >
                  <MoreHorizontalIcon aria-hidden />
                </MenuTrigger>
                <MenuPopup align="start" side="bottom" sideOffset={4}>
                  {saveAsRegression === null ? null : (
                    <MenuItem onClick={() => void saveAsRegression()}>
                      <RepeatIcon className="size-3.5" />
                      <T>Save as regression</T>
                    </MenuItem>
                  )}
                  {run.reportHtmlPath && run.reportMarkdownPath ? (
                    <MenuItem
                      onClick={() =>
                        useRightPanelStore.getState().openFile(threadRef, run.reportMarkdownPath!)
                      }
                    >
                      <FileTextIcon className="size-3.5" />
                      report.md
                    </MenuItem>
                  ) : null}
                  {canOpenFolder ? (
                    <MenuItem onClick={() => void openFolder(run.dir)}>
                      <FolderOpenIcon className="size-3.5" />
                      <T>Evidence folder</T>
                    </MenuItem>
                  ) : null}
                  {canDelete ? (
                    <MenuItem variant="destructive" onClick={() => setConfirmDelete(run)}>
                      <Trash2Icon className="size-3.5" />
                      <T>Delete</T>
                    </MenuItem>
                  ) : null}
                </MenuPopup>
              </Menu>
            </div>

            {earlierRuns.length > 0 ? (
              <>
                <ThreadDetailsControl
                  size="sm"
                  variant="ghost"
                  part="row"
                  aria-expanded={showHistory}
                  onClick={() => setShowHistory(!showHistory)}
                >
                  <HistoryIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
                  <span className="flex-1 truncate">
                    <T>
                      Earlier runs (<Var>{earlierRuns.length}</Var>)
                    </T>
                  </span>
                </ThreadDetailsControl>
                {showHistory
                  ? earlierRuns.map((earlier) => (
                      <ThreadDetailsControl
                        key={earlier.runId}
                        size="sm"
                        variant="ghost"
                        part="row"
                        multiline
                        onClick={() => {
                          setSelectedRunId(earlier.runId);
                          setExpanded(null);
                        }}
                      >
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="truncate text-xs">{runStartedLabel(earlier)}</span>
                          <VerdictSummary run={earlier} />
                        </span>
                      </ThreadDetailsControl>
                    ))
                  : null}
              </>
            ) : null}
          </>
        )}
      </div>

      <AlertDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>Delete this run's evidence?</T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>
                Its screenshots, video, logs and reports are removed from disk. This cannot be
                undone.
              </T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => confirmDelete && void removeRun(confirmDelete)}
            >
              <T>Delete</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </ThreadDetailsSection>
  );
}
