import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId, ProjectId, NavigationSummary } from "@t3tools/contracts";
import {
  mergeNavigationStates,
  navigationCountSuffix,
  navigationInvalidation,
  recognitionCheckLabel,
  relativeSubgroup,
  navigationTotals,
} from "@t3tools/client-runtime/state/projectNavigation";
import { useEffect, useEffectEvent, useState } from "react";
import { useGT, useMessages } from "gt-react-native";
import { View } from "react-native";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { AppBar } from "../../components/ui/AppBar";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { ListRow } from "../../components/ui/ListRow";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

type Params = {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  cluster?: { environment: string; pathGroup: string; prefix?: string };
  stateId?: string;
};

export function ProjectNavigationEntry(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const gt = useGT();
  const navigation = useNavigation();
  const overview = useEnvironmentQuery(
    serverEnvironment.navigationOverview({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    }),
  );
  const totals = navigationTotals(overview.data?.clusters ?? []);
  return (
    <ListRow
      label={gt("Navigation")}
      description={gt("{screens} screens · {connections} connections", {
        screens: `${totals.screens}${navigationCountSuffix(overview.data?.truncated)}`,
        connections: `${totals.connections}${navigationCountSuffix(overview.data?.truncated)}`,
      })}
      onPress={() => navigation.dispatch(StackActions.push("ProjectNavigation", props))}
    />
  );
}

export function ProjectNavigationScreen({ route }: StaticScreenProps<Params>) {
  return <NavigationPage key={JSON.stringify(route.params)} {...route.params} />;
}

function NavigationPage(props: Params) {
  const gt = useGT();
  const messages = useMessages();
  const navigation = useNavigation();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState<{ cursor?: string; previous: readonly NavigationSummary[] }>({
    previous: [],
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Debounce remote search and cancel the timer when this page closes.
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(query.trim());
      setPage({ previous: [] });
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);
  const target = { environmentId: props.environmentId, input: { projectId: props.projectId } };
  const overview = useEnvironmentQuery(serverEnvironment.navigationOverview(target));
  const children = useEnvironmentQuery(
    props.cluster && !debounced && !props.stateId
      ? serverEnvironment.navigationChildren({
          environmentId: props.environmentId,
          input: { projectId: props.projectId, ...props.cluster, cursor: page.cursor, limit: 100 },
        })
      : null,
  );
  const search = useEnvironmentQuery(
    debounced && debounced === query.trim()
      ? serverEnvironment.navigationSearch({
          environmentId: props.environmentId,
          input: { projectId: props.projectId, query: debounced, cursor: page.cursor, limit: 50 },
        })
      : null,
  );
  const details = useEnvironmentQuery(
    props.stateId
      ? serverEnvironment.navigationDetails({
          environmentId: props.environmentId,
          input: { projectId: props.projectId, stateId: props.stateId },
        })
      : null,
  );
  const neighborhood = useEnvironmentQuery(
    props.stateId
      ? serverEnvironment.navigationNeighborhood({
          environmentId: props.environmentId,
          input: { projectId: props.projectId, stateId: props.stateId, limit: 100 },
        })
      : null,
  );
  const live = useEnvironmentQuery(serverEnvironment.navigationLive(target));
  const changed = useEffectEvent((event: NonNullable<typeof live.data>) => {
    const invalid = navigationInvalidation(event, {
      cluster: props.cluster,
      stateIds: [
        props.stateId ?? "",
        ...(neighborhood.data?.incoming.map((n) => n.state.id) ?? []),
        ...(neighborhood.data?.outgoing.map((n) => n.state.id) ?? []),
      ],
    });
    overview.refresh();
    if ((debounced && invalid.search) || (!debounced && invalid.children)) {
      setPage({ previous: [] });
      if (!page.cursor) {
        children.refresh();
        search.refresh();
      }
    }
    if (invalid.selection) {
      details.refresh();
      neighborhood.refresh();
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Refresh bounded queries on committed navigation events while mounted.
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- A remote revision invalidates accumulated cursor pages as well as their RPCs.
    if (live.data) changed(live.data);
  }, [live.data]);
  const open = (next: Partial<Params>) =>
    navigation.dispatch(
      StackActions.push("ProjectNavigation", {
        environmentId: props.environmentId,
        projectId: props.projectId,
        ...next,
      }),
    );
  const result = debounced ? search : children;
  const states = mergeNavigationStates(page.previous, result.data?.states ?? []);
  const state = details.data?.state;
  const error = overview.error ?? result.error ?? details.error ?? neighborhood.error ?? live.error;
  return (
    <View className="flex-1 bg-screen">
      <AppBar
        title={state?.name ?? props.cluster?.prefix ?? props.cluster?.pathGroup ?? gt("Navigation")}
        onBack={() => navigation.goBack()}
      />
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-3 p-4"
      >
        {error ? <Text accessibilityRole="alert">{error}</Text> : null}
        {!props.stateId ? (
          <AppTextInput
            accessibilityLabel={gt("Search navigation")}
            placeholder={gt("Search navigation")}
            value={query}
            maxLength={160}
            onChangeText={setQuery}
            className="rounded-lg border border-border-subtle p-3 text-foreground"
          />
        ) : null}
        {result.isPending || details.isPending ? <Text>{gt("Loading navigation…")}</Text> : null}
        {!props.stateId && !props.cluster && !debounced
          ? overview.data?.clusters.map((c) => (
              <ListRow
                key={JSON.stringify([c.environment, c.pathGroup])}
                label={`${c.environment}${c.pathGroup}`}
                description={gt(
                  "{screens} screens · {connections} connections",
                  navigationTotals([c]),
                )}
                onPress={() => open({ cluster: c })}
              />
            ))
          : null}
        {!props.stateId ? (
          <>
            {!debounced && children.data?.kind === "subgroups"
              ? children.data.subgroups.map((group) => (
                  <ListRow
                    key={group.prefix}
                    label={relativeSubgroup(group.prefix, props.cluster?.prefix)}
                    detail={`${group.stateCount}${navigationCountSuffix(group.countCapped)}`}
                    onPress={() => {
                      if (props.cluster)
                        open({ cluster: { ...props.cluster, prefix: group.prefix } });
                    }}
                  />
                ))
              : null}
            {states.map((s) => (
              <ListRow
                key={s.id}
                label={s.name}
                description={`${s.environment}${s.path}`}
                detail={s.hasNeedsRecheck ? gt("Needs recheck") : undefined}
                onPress={() => open({ stateId: s.id })}
              />
            ))}
            {result.data &&
            states.length === 0 &&
            !(children.data?.kind === "subgroups" && children.data.subgroups.length) ? (
              <Text>{gt("No states found.")}</Text>
            ) : null}
            {result.data?.nextCursor ? (
              <ListRow
                label={gt("Load more")}
                disabled={result.isPending}
                onPress={() => {
                  if (result.data?.nextCursor)
                    setPage({ cursor: result.data.nextCursor, previous: states });
                }}
              />
            ) : null}
          </>
        ) : null}
        {state ? (
          <>
            <Text selectable>
              {state.environment}
              {state.path}
            </Text>
            <Text>{gt("Context")}</Text>
            {Object.entries(state.context).map(([key, value]) => (
              <Text key={key}>
                {key}: {value}
              </Text>
            ))}
            <Text>{gt("Recognition checks")}</Text>
            {state.checks.map((check) => (
              <Text key={JSON.stringify(check)}>{recognitionCheckLabel(check, messages)}</Text>
            ))}
            {(["incoming", "outgoing"] as const).map((direction) => (
              <View key={direction} className="gap-2">
                <Text>
                  {direction === "incoming"
                    ? gt("Incoming connections")
                    : gt("Outgoing connections")}
                </Text>
                {neighborhood.data?.[direction].map(({ transition, state: neighbor }) => (
                  <ListRow
                    key={transition.id}
                    label={neighbor.name}
                    description={transition.action}
                    detail={transition.available ? gt("Available") : gt("Needs recheck")}
                    onPress={() => open({ stateId: neighbor.id })}
                  />
                ))}
              </View>
            ))}
            <Text>{gt("Supporting runs")}</Text>
            {details.data?.runs.map((run) => (
              <Text selectable key={`${run.runId}:${run.threadId}`}>
                {run.runId} · {run.observedAt}
              </Text>
            ))}
          </>
        ) : null}
        {overview.data?.truncated ||
        result.data?.truncated ||
        details.data?.truncated ||
        neighborhood.data?.truncated ? (
          <Text>{gt("More records exist than are shown.")}</Text>
        ) : null}
      </ScreenScrollView>
    </View>
  );
}
