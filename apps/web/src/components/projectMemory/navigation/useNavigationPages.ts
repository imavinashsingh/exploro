import { mergeNavigationStates } from "@t3tools/client-runtime/state/projectNavigation";
import type { EnvironmentId, ProjectId, NavigationSummary } from "@t3tools/contracts";
import { useState } from "react";
import { useEnvironmentQuery } from "../../../state/query";
import { serverEnvironment } from "../../../state/server";

export function useNavigationPages(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  query?: string | undefined;
  cluster?: { environment: string; pathGroup: string; prefix?: string } | undefined;
}) {
  const key = JSON.stringify([props.environmentId, props.projectId, props.query, props.cluster]);
  const [page, setPage] = useState<{
    key: string;
    cursor?: string | undefined;
    previous: readonly NavigationSummary[];
  }>({ key, previous: [] });
  const current = page.key === key ? page : { key, cursor: undefined, previous: [] };
  if (page.key !== key) setPage(current);
  const search = useEnvironmentQuery(
    props.query
      ? serverEnvironment.navigationSearch({
          environmentId: props.environmentId,
          input: {
            projectId: props.projectId,
            query: props.query,
            limit: 50,
            cursor: current.cursor,
          },
        })
      : null,
  );
  const children = useEnvironmentQuery(
    props.cluster
      ? serverEnvironment.navigationChildren({
          environmentId: props.environmentId,
          input: {
            projectId: props.projectId,
            ...props.cluster,
            limit: 100,
            cursor: current.cursor,
          },
        })
      : null,
  );
  const result = props.cluster ? children : search;
  const states = mergeNavigationStates(current.previous, result.data?.states ?? []);
  return {
    ...result,
    states,
    refresh: () => {
      setPage({ key, previous: [] });
      if (!current.cursor) result.refresh();
    },
    subgroups: children.data?.kind === "subgroups" ? children.data.subgroups : [],
    connections: children.data?.kind === "states" ? children.data.connections : [],
    connectionsTruncated: children.data?.kind === "states" && children.data.connectionsTruncated,
    loadMore: () => {
      if (result.data?.nextCursor)
        setPage({ key, cursor: result.data.nextCursor, previous: states });
    },
  };
}
