import type { EnvironmentId, ProjectId, NavigationRevision } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";
import { useEnvironmentQuery } from "../../../state/query";
import { serverEnvironment } from "../../../state/server";

export function useNavigationLive(
  props: { environmentId: EnvironmentId; projectId: ProjectId },
  onChange: (event: NavigationRevision) => void,
) {
  const live = useEnvironmentQuery(
    serverEnvironment.navigationLive({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    }),
  );
  const change = useEffectEvent(onChange);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Refresh remote queries when a committed navigation revision arrives.
  useEffect(() => {
    if (live.data) change(live.data);
  }, [live.data]);
}
