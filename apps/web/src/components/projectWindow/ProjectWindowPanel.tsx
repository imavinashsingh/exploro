import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { FolderKanbanIcon } from "lucide-react";
import { useState } from "react";

import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { ProjectRunsTab } from "./ProjectRunsTab";
import { ProjectSuitesTab } from "./ProjectSuitesTab";
import { useProjectQa, useProjectRuns } from "./useProjectQa";

const TABS = ["suites", "runs"] as const;
type ProjectWindowTab = (typeof TABS)[number];

/** Project-level QA tools beside the chat: suites and runs. */
export default function ProjectWindowPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | null;
  readonly projectName: string | null;
}) {
  const gt = useGT();
  const [tab, setTab] = useState<ProjectWindowTab>("suites");
  const qa = useProjectQa(props.environmentId, props.projectId, props.threadId);
  const { runs, titles } = useProjectRuns(props.environmentId, props.projectId, props.threadId, qa);
  const countLabel = (label: string, count: number) => (count > 0 ? `${label} ${count}` : label);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border/65 px-3 py-2.5">
        <FolderKanbanIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {props.projectName ?? gt("This thread")}
          </div>
          <div className="text-xs text-muted-foreground">{gt("Project window")}</div>
        </div>
      </div>
      <div className="border-b border-border/65 px-3 py-2">
        <ToggleGroup
          aria-label={gt("Project window sections")}
          className="w-full *:flex-1"
          value={[tab]}
          onValueChange={(next) => {
            const value = next[0];
            if (TABS.includes(value as ProjectWindowTab)) setTab(value as ProjectWindowTab);
          }}
        >
          <Toggle value="suites">{countLabel(gt("Suites"), qa.suites.length)}</Toggle>
          <Toggle value="runs">{gt("Runs", { $context: "test runs" })}</Toggle>
        </ToggleGroup>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {qa.error !== null ? (
          <p className="m-0 px-3 py-6 text-center text-xs text-destructive">{qa.error}</p>
        ) : tab === "suites" ? (
          <ProjectSuitesTab
            environmentId={props.environmentId}
            projectId={props.projectId}
            qa={qa}
            runs={runs}
          />
        ) : (
          <ProjectRunsTab environmentId={props.environmentId} runs={runs} titles={titles} />
        )}
      </div>
    </div>
  );
}
