import { recognitionCheckLabel } from "@t3tools/client-runtime/state/projectNavigation";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useGT, useMessages } from "gt-react";
import { useEnvironmentQuery } from "../../../state/query";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import { CopyIcon } from "lucide-react";
import { Badge } from "../../ui/badge";
import { ScrollArea } from "../../ui/scroll-area";
import { Separator } from "../../ui/separator";
import { Skeleton } from "../../ui/skeleton";
import { useRelativeTimeState } from "../../../hooks/useRelativeTimeState";
import { Button } from "../../ui/button";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "../../ui/alert-dialog";

function RunDate({ date }: { date: string }) {
  const time = useRelativeTimeState(date);
  return <span>{time.status === "relative" ? time.label : date}</span>;
}

export function NavigationDetailsPanel(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  stateId: string;
  onDeleted: () => void;
  onRouteFrom: () => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const { copyToClipboard } = useCopyToClipboard();
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const details = useEnvironmentQuery(
    serverEnvironment.navigationDetails({
      environmentId: props.environmentId,
      input: { projectId: props.projectId, stateId: props.stateId },
    }),
  );
  const canDelete = useAtomValue(
    serverEnvironment.deleteNavigationRecord.permissionAtom(props.environmentId),
  );
  const remove = useAtomCommand(serverEnvironment.deleteNavigationRecord, {
    label: "delete navigation record",
  });
  const data = details.data;
  const state = data?.state;
  return (
    <aside className="h-full text-sm" aria-label={gt("State details")}>
      <ScrollArea>
        <div className="flex flex-col gap-3 p-4">
          {details.error && <p role="alert">{details.error}</p>}
          {details.isPending && <Skeleton className="h-40 w-full" />}
          {state && (
            <>
              <h3 className="text-base font-semibold">{state.name}</h3>
              <div className="flex flex-wrap gap-1">
                {state.aliases.map((alias) => (
                  <Badge key={alias} variant="secondary">
                    {alias}
                  </Badge>
                ))}
              </div>
              <div className="flex items-start gap-2">
                <p className="min-w-0 flex-1 break-all font-mono text-xs">
                  {new URL(state.environment).host}
                  {state.path}
                </p>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={gt("Copy address")}
                  onClick={() => copyToClipboard(state.environment + state.path, undefined)}
                >
                  <CopyIcon />
                </Button>
              </div>
              <Separator />
              <h4 className="font-medium">{gt("Context")}</h4>
              <dl>
                {Object.entries(state.context).map(([key, value]) => (
                  <div key={key} className="grid grid-cols-2 gap-2 py-1">
                    <dt className="text-muted-foreground">{key}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              <h4>{gt("Recognition checks")}</h4>
              <ul className="space-y-2 text-xs">
                {state.checks.map((check) => (
                  <li key={JSON.stringify(check)} className="rounded-md border p-2">
                    {recognitionCheckLabel(check, messages)}
                  </li>
                ))}
              </ul>
              <Separator />
              <p>
                {gt("{incoming} incoming · {outgoing} outgoing · {recheck} need recheck", {
                  incoming: data.incomingCount,
                  outgoing: data.outgoingCount,
                  recheck: data.needsRecheckCount,
                })}
              </p>
              <h4>{gt("Supporting runs")}</h4>
              <ul className="space-y-2 break-all text-xs">
                {data.runs.map((run) => (
                  <li key={`${run.runId}:${run.threadId}`}>
                    <span>
                      {run.runId.slice(0, 8)} · <RunDate date={run.observedAt} />
                    </span>
                    <br />
                    <Link
                      to="/$environmentId/$threadId"
                      params={{
                        environmentId: props.environmentId,
                        threadId: run.threadId as ThreadId,
                      }}
                    >
                      {run.threadId.slice(0, 8)}
                    </Link>
                  </li>
                ))}
              </ul>
              {data.truncated && <p>{gt("More records exist than are shown.")}</p>}
              <Button size="sm" variant="outline" onClick={props.onRouteFrom}>
                {gt("Route from here")}
              </Button>
              <Button
                size="sm"
                variant="destructive-outline"
                disabled={!canDelete || pending}
                onClick={() => setConfirm(true)}
              >
                {gt("Delete from memory")}
              </Button>
              {error && <p role="alert">{gt("Could not delete navigation state")}</p>}
              <AlertDialog open={confirm} onOpenChange={setConfirm}>
                <AlertDialogPopup>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{gt("Delete this screen from memory?")}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {gt("This removes the screen and its connections from project memory.")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <Button variant="outline" disabled={pending} onClick={() => setConfirm(false)}>
                      {gt("Cancel")}
                    </Button>
                    <Button
                      variant="destructive"
                      disabled={!canDelete || pending}
                      onClick={async () => {
                        setPending(true);
                        const result = await remove({
                          environmentId: props.environmentId,
                          input: { projectId: props.projectId, id: props.stateId },
                        });
                        setPending(false);
                        if (result._tag === "Success") {
                          details.refresh();
                          setConfirm(false);
                          props.onDeleted();
                        } else setError(true);
                      }}
                    >
                      {gt("Delete from memory")}
                    </Button>
                  </AlertDialogFooter>
                </AlertDialogPopup>
              </AlertDialog>
            </>
          )}
        </div>
      </ScrollArea>
    </aside>
  );
}
