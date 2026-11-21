import type { ReactNode } from "react";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { lazy, Suspense, useState } from "react";
import { useGT } from "gt-react";
import { useEnvironmentQueryRefresh } from "../../../state/query";
import { serverEnvironment } from "../../../state/server";
import { Skeleton } from "../../ui/skeleton";
import { Button } from "../../ui/button";
import { Dialog, DialogPopup } from "../../ui/dialog";

const ProjectNavigationExplorer = lazy(() => import("./ProjectNavigationExplorer"));

export function ProjectNavigationDialog(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  initialSearch?: string | undefined;
  initialCluster?: { environment: string; pathGroup: string } | undefined;
  children?: ReactNode;
  compact?: boolean;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const overview = useEnvironmentQueryRefresh(
    serverEnvironment.navigationOverview({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    }),
  );
  return (
    <>
      <Button
        size="sm"
        className={props.compact ? "w-full min-w-0 justify-start overflow-hidden" : undefined}
        variant="outline"
        onClick={() => {
          overview.refresh();
          setOpen(true);
        }}
      >
        <span className="min-w-0 truncate">{props.children ?? gt("Open explorer")}</span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup size="workspace">
          {open && (
            <Suspense fallback={<Skeleton className="h-80 w-full" />}>
              <ProjectNavigationExplorer
                key={`${props.environmentId}:${props.projectId}`}
                environmentId={props.environmentId}
                projectId={props.projectId}
                initialSearch={props.initialSearch}
                initialCluster={props.initialCluster}
              />
            </Suspense>
          )}
        </DialogPopup>
      </Dialog>
    </>
  );
}
