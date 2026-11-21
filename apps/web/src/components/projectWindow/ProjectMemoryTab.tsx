import {
  memoryStatusLine,
  understandingBadge,
  understandingByKind,
  type UnderstandingBadge,
} from "@t3tools/client-runtime/state/projectMemory";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  ProjectId,
  ProjectMemoryFact,
  PROJECT_UNDERSTANDING_KINDS,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { msg, T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { ProjectNavigationSummary } from "../projectMemory/navigation/ProjectNavigationSummary";

import { cn } from "../../lib/utils";
import { useProject, useServerConfigs } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Badge } from "../ui/badge";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

const KIND_LABEL = {
  workflow: msg("Workflows"),
  dependency: msg("Dependencies"),
  "test-strategy": msg("Test strategies"),
  lesson: msg("Lessons"),
  "open-question": msg("Open questions"),
} as const satisfies Record<(typeof PROJECT_UNDERSTANDING_KINDS)[number], string>;

const BADGE_VARIANT = {
  confirmed: "success",
  verified: "info",
  hypothesis: "outline",
  "needs review": "warning",
} as const satisfies Record<UnderstandingBadge, string>;

const TONE_CLASS = {
  ready: "text-muted-foreground",
  busy: "text-muted-foreground",
  failed: "text-destructive",
  off: "text-muted-foreground",
} as const;

/** Current facts grouped by page, so "what do we know about /login" reads as one block. */
function factsByPage(facts: ReadonlyArray<ProjectMemoryFact>) {
  const pages = new Map<
    string,
    { route: string; stateName: string; environment: string; facts: ProjectMemoryFact[] }
  >();
  for (const fact of facts) {
    const key = fact.stateId;
    const page = pages.get(key) ?? {
      route: fact.route,
      stateName: fact.stateName,
      environment: fact.environment,
      facts: [],
    };
    page.facts.push(fact);
    pages.set(key, page);
  }
  return [...pages.entries()]
    .map(([key, page]) => ({ key, ...page }))
    .sort((a, b) => a.environment.localeCompare(b.environment) || a.route.localeCompare(b.route));
}

/** What test runs in this project have learned, read-only; editing stays in project settings. */
export function ProjectMemoryTab(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
}) {
  const gt = useGT();
  const messages = useMessages();
  const [view, setView] = useState<"understanding" | "facts" | "navigation">("understanding");
  const project = useProject(
    props.projectId === null ? null : scopeProjectRef(props.environmentId, props.projectId),
  );
  const serverConfig = useServerConfigs().get(props.environmentId);
  const scratch =
    project !== null &&
    serverConfig !== undefined &&
    isScratchProject(project, serverConfig.scratchWorkspaceRoot);
  const enabled =
    project !== null &&
    serverConfig !== undefined &&
    resolveProjectSettings(serverConfig.settings, project.id).settings.qaMemoryEnabled;
  const snapshot = useEnvironmentQuery(
    props.projectId === null || scratch
      ? null
      : serverEnvironment.projectMemorySnapshot({
          environmentId: props.environmentId,
          input: { projectId: props.projectId },
        }),
  );

  const navigation = useEnvironmentQuery(
    props.projectId === null || scratch
      ? null
      : serverEnvironment.navigationOverview({
          environmentId: props.environmentId,
          input: { projectId: props.projectId },
        }),
  );

  if (props.projectId === null || scratch)
    return (
      <p className="m-0 px-3 py-6 text-center text-xs text-muted-foreground">
        <T>Memory is off: this test isn't in a project.</T>
      </p>
    );

  const data = snapshot.data;
  const status = memoryStatusLine(data?.status ?? null, enabled, messages);
  const currentFacts = (data?.facts ?? []).filter((fact) => fact.status === "current");
  const pages = factsByPage(currentFacts);
  const groups = understandingByKind(data?.understanding ?? []);
  const needsReview = (data?.understanding ?? []).filter(
    (item) => understandingBadge(item) === "needs review",
  ).length;
  const empty = data !== undefined && currentFacts.length === 0 && groups.length === 0;

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className={cn(TONE_CLASS[status.tone])}>{status.text}</span>
        {needsReview > 0 ? (
          <Badge size="sm" variant="warning">
            {gt("{count} to review", { count: needsReview })}
          </Badge>
        ) : null}
      </div>
      <ToggleGroup
        aria-label={gt("Memory view")}
        className="w-full *:flex-1"
        value={[view]}
        onValueChange={(next) => {
          if (next[0] === "understanding" || next[0] === "facts" || next[0] === "navigation")
            setView(next[0]);
        }}
      >
        <Toggle value="understanding">
          {gt("What we learned · {count}", { count: data?.understanding.length ?? 0 })}
        </Toggle>
        <Toggle value="facts">{gt("Page facts · {count}", { count: currentFacts.length })}</Toggle>
        <Toggle value="navigation">
          {gt("Navigation · {count}", {
            count: `${navigation.data?.clusters.reduce((sum, cluster) => sum + cluster.stateCount, 0) ?? 0}${navigation.data?.truncated ? "+" : ""}`,
          })}
        </Toggle>
      </ToggleGroup>
      {view === "navigation" ? (
        <ProjectNavigationSummary environmentId={props.environmentId} projectId={props.projectId} />
      ) : snapshot.error !== null ? (
        <p className="m-0 text-xs text-destructive">{snapshot.error}</p>
      ) : empty ? (
        <p className="m-0 px-3 py-4 text-center text-xs text-muted-foreground">
          <T>
            Nothing learned yet. Save a finished test to memory and what it found shows up here.
          </T>
        </p>
      ) : view === "understanding" ? (
        groups.length === 0 ? (
          <p className="m-0 px-3 py-4 text-center text-xs text-muted-foreground">
            <T>No conclusions yet. They are drawn from the page facts after a few runs.</T>
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.kind} className="flex flex-col gap-1.5">
              <h4 className="m-0 text-xs font-medium text-muted-foreground">
                {messages(KIND_LABEL[group.kind])} · {group.items.length}
              </h4>
              {group.items.map((item) => {
                const badge = understandingBadge(item);
                return (
                  <article
                    key={item.itemId}
                    className="flex flex-col gap-1.5 rounded-lg border border-border/65 px-3 py-2"
                  >
                    <p className="m-0 text-sm leading-snug">{item.statement}</p>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground">
                      <Badge size="sm" variant={BADGE_VARIANT[badge]}>
                        {badge}
                      </Badge>
                      {item.citedFactIds.length > 0 ? (
                        <span>
                          {gt(
                            "{count, plural, one {Based on {count} fact} other {Based on {count} facts}}",
                            { count: item.citedFactIds.length },
                          )}
                        </span>
                      ) : null}
                      <span>{item.updatedAt.slice(0, 10)}</span>
                    </div>
                  </article>
                );
              })}
            </section>
          ))
        )
      ) : pages.length === 0 ? (
        <p className="m-0 px-3 py-4 text-center text-xs text-muted-foreground">
          <T>No page facts yet. Finished test runs add them.</T>
        </p>
      ) : (
        pages.map((page) => (
          <section
            key={page.key}
            className="flex flex-col overflow-hidden rounded-lg border border-border/65"
          >
            <header className="flex items-baseline justify-between gap-2 bg-muted/40 px-3 py-1.5">
              <h4 className="m-0 truncate font-mono text-xs font-medium">
                {page.stateName} · {page.route}
              </h4>
              <span className="truncate text-2xs text-muted-foreground">{page.environment}</span>
            </header>
            <dl className="m-0 flex flex-col">
              {page.facts.map((fact) => (
                <div
                  key={fact.factId}
                  className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-3 border-t border-border/65 px-3 py-1.5 text-sm first:border-t-0"
                >
                  <dt className="m-0 break-words text-muted-foreground">{fact.key}</dt>
                  <dd className="m-0 flex flex-col gap-0.5 break-words">
                    <span>{fact.value}</span>
                    {fact.mayBeOutdated ? (
                      <span className="text-2xs text-warning-foreground">
                        {gt("May be outdated")}
                      </span>
                    ) : null}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))
      )}
      <p className="m-0 text-xs text-muted-foreground">
        <T>To edit or remove what is remembered, open the project's settings and choose Memory.</T>
      </p>
    </div>
  );
}
