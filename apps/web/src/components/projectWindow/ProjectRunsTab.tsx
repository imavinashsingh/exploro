import type { EnvironmentId, QaRun } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";

import { Badge } from "../ui/badge";
import {
  runStartedLabel,
  VERDICT_BADGE_VARIANT,
  verdictSummary,
} from "../chat/threadDetailsTestRun.logic";

const RUN_LIMIT = 30;

/** The project's newest test runs, each opening the thread that holds its evidence. */
export function ProjectRunsTab(props: {
  readonly environmentId: EnvironmentId;
  readonly runs: ReadonlyArray<QaRun>;
  readonly titles: ReadonlyMap<string, string>;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const runs = props.runs
    .toSorted((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, RUN_LIMIT);

  if (runs.length === 0)
    return (
      <p className="m-0 px-3 py-6 text-center text-xs text-muted-foreground">
        <T>No test runs yet. Ask an agent to test the app, and its verdicts show up here.</T>
      </p>
    );

  return (
    <div className="flex flex-col gap-2 p-3">
      <ul className="m-0 flex list-none flex-col p-0">
        {runs.map((run) => {
          const summary = verdictSummary(run);
          return (
            <li
              key={`${run.threadId}:${run.runId}`}
              className="border-b border-border/65 last:border-b-0"
            >
              <button
                type="button"
                className="flex w-full min-w-0 flex-col gap-1 py-2 text-start hover:bg-accent/40"
                onClick={() =>
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: { environmentId: props.environmentId, threadId: run.threadId },
                  })
                }
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {props.titles.get(run.threadId) ?? run.site ?? gt("Test run")}
                  </span>
                  {run.kind === "regression" ? (
                    <Badge size="sm" variant="outline">
                      <T>Regression</T>
                    </Badge>
                  ) : null}
                </span>
                <span className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground">
                  {summary.length === 0 ? (
                    <T>No verdicts yet</T>
                  ) : (
                    summary.map(({ verdict, count }) => (
                      <Badge key={verdict} size="sm" variant={VERDICT_BADGE_VARIANT[verdict]}>
                        {verdict} {count}
                      </Badge>
                    ))
                  )}
                  <span className="ms-auto shrink-0">
                    {run.finishedAt === null
                      ? gt("Running", { $context: "test run status" })
                      : runStartedLabel(run)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {props.runs.length > RUN_LIMIT ? (
        <p className="m-0 text-center text-xs text-muted-foreground">
          {gt("Showing the newest {count} runs.", { count: RUN_LIMIT })}
        </p>
      ) : null}
    </div>
  );
}
