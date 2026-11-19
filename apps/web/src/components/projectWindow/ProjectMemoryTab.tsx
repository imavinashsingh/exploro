import {
  memoryStatusLine,
  understandingBadge,
  understandingByKind,
  type UnderstandingBadge,
} from "@t3tools/client-runtime/state/projectMemory";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, PROJECT_UNDERSTANDING_KINDS } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { msg, T, useGT, useMessages } from "gt-react";

import { cn } from "../../lib/utils";
import { useProject, useServerConfigs } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Badge } from "../ui/badge";

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

/** What test runs in this project have learned, read-only; editing stays in project settings. */
export function ProjectMemoryTab(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
}) {
  const gt = useGT();
  const messages = useMessages();
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

  if (props.projectId === null || scratch)
    return (
      <p className="m-0 px-3 py-6 text-center text-xs text-muted-foreground">
        <T>Memory is off: this test isn't in a project.</T>
      </p>
    );

  const data = snapshot.data;
  const status = memoryStatusLine(data?.status ?? null, enabled, messages);
  const currentFacts = (data?.facts ?? []).filter((fact) => fact.status === "current").length;
  const groups = understandingByKind(data?.understanding ?? []);

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex flex-col gap-1 rounded-md bg-muted/40 px-2.5 py-2 text-xs">
        <span className={cn(TONE_CLASS[status.tone])}>{status.text}</span>
        <span className="text-muted-foreground">
          {gt(
            "{facts, plural, one {{facts} fact} other {{facts} facts}} · {items, plural, one {{items} learned item} other {{items} learned items}}",
            { facts: currentFacts, items: data?.understanding.length ?? 0 },
          )}
        </span>
      </div>
      {snapshot.error !== null ? (
        <p className="m-0 text-xs text-destructive">{snapshot.error}</p>
      ) : groups.length === 0 ? (
        <p className="m-0 px-3 py-4 text-center text-xs text-muted-foreground">
          <T>
            Nothing learned yet. Save a finished test to memory and what it found shows up here.
          </T>
        </p>
      ) : (
        groups.map((group) => (
          <section key={group.kind} className="flex flex-col">
            <h4 className="m-0 mb-1 text-xs font-medium text-muted-foreground">
              {messages(KIND_LABEL[group.kind])}
            </h4>
            <ul className="m-0 flex list-none flex-col p-0">
              {group.items.map((item) => {
                const badge = understandingBadge(item);
                return (
                  <li
                    key={item.itemId}
                    className="flex items-start gap-2 border-b border-border/65 py-1.5 text-sm last:border-b-0"
                  >
                    <span className="min-w-0 flex-1">{item.statement}</span>
                    <Badge size="sm" variant={BADGE_VARIANT[badge]}>
                      {badge}
                    </Badge>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
      <p className="m-0 text-xs text-muted-foreground">
        <T>To edit or remove what is remembered, open the project's settings and choose Memory.</T>
      </p>
    </div>
  );
}
