import { useNavigationLive } from "./useNavigationLive";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useState } from "react";
import { useGT } from "gt-react";
import { useEnvironmentQuery } from "../../../state/query";
import { serverEnvironment } from "../../../state/server";
import { Input } from "../../ui/input";
import { ProjectNavigationDialog } from "./ProjectNavigationDialog";

export function ProjectNavigationSummary(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const gt = useGT();
  const [query, setQuery] = useState("");
  const overview = useEnvironmentQuery(
    serverEnvironment.navigationOverview({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    }),
  );
  useNavigationLive(props, () => overview.refresh());
  return (
    <section className="flex min-w-0 flex-col gap-3 overflow-x-hidden text-xs">
      <Input
        type="search"
        maxLength={160}
        aria-label={gt("Search navigation")}
        placeholder={gt("Search navigation")}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <ProjectNavigationDialog {...props} initialSearch={query} />
      {overview.error && <p role="alert">{overview.error}</p>}
      {overview.isPending && <p role="status">{gt("Loading navigation…")}</p>}
      {[...new Set(overview.data?.clusters.map((c) => c.environment))].map(
        (environment, _, environments) => (
          <div key={environment} className="min-w-0">
            {environments.length > 1 && (
              <p className="mb-2 truncate text-muted-foreground">{new URL(environment).host}</p>
            )}
            <ul className="max-h-80 min-w-0 space-y-2 overflow-y-auto overflow-x-hidden">
              {overview.data?.clusters
                .filter((c) => c.environment === environment)
                .toSorted(
                  (a, b) => b.stateCount - a.stateCount || a.pathGroup.localeCompare(b.pathGroup),
                )
                .slice(0, 8)
                .map((cluster) => (
                  <li key={cluster.pathGroup} className="min-w-0">
                    <ProjectNavigationDialog {...props} initialCluster={cluster} compact>
                      {cluster.pathGroup} ·{" "}
                      {gt(
                        "{count, plural, one {# screen} other {# screens}} · {connections, plural, one {# connection} other {# connections}}",
                        { count: cluster.stateCount, connections: cluster.outgoingCount },
                      )}
                    </ProjectNavigationDialog>
                  </li>
                ))}
            </ul>
          </div>
        ),
      )}
      {overview.data?.truncated && <p>{gt("More records exist than are shown.")}</p>}
    </section>
  );
}
