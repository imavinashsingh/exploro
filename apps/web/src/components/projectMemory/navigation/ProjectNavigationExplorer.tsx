import {
  navigationCountSuffix,
  navigationInvalidation,
  stateLocation,
  relativeSubgroup,
  commonPathParent,
} from "@t3tools/client-runtime/state/projectNavigation";
import { useNavigationLive } from "./useNavigationLive";
import type {
  EnvironmentId,
  ProjectId,
  NavigationSummary,
  NavigationTransition,
} from "@t3tools/contracts";
import type { Edge } from "@xyflow/react";
import { useEffect, useState } from "react";
import { useGT } from "gt-react";
import { RefreshCwIcon, ChevronRightIcon } from "lucide-react";
import { useMediaQuery } from "../../../hooks/useMediaQuery";
import { useEnvironmentQuery, useEnvironmentQueryRefresh } from "../../../state/query";
import { serverEnvironment } from "../../../state/server";
import { DialogTitle } from "../../ui/dialog";
import { Button } from "../../ui/button";
import { Toggle, ToggleGroup } from "../../ui/toggle-group";
import {
  Autocomplete,
  AutocompleteInput,
  AutocompletePopup,
  AutocompleteList,
  AutocompleteItem,
  AutocompleteEmpty,
} from "../../ui/autocomplete";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../../ui/tooltip";
import { Empty, EmptyDescription } from "../../ui/empty";
import { Skeleton } from "../../ui/skeleton";
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from "../../ui/table";
import { ScrollArea } from "../../ui/scroll-area";
import { NavigationCanvas } from "./NavigationCanvas";
import { NavigationDetailsPanel } from "./NavigationDetailsPanel";
import {
  clusterId,
  levelKey,
  navigationLayout,
  type NavigationLevel,
  type LayoutItem,
  type Positions,
} from "./navigationLayout.logic";
import { useNavigationPages } from "./useNavigationPages";

export default function ProjectNavigationExplorer(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  initialSearch?: string | undefined;
  initialCluster?: { environment: string; pathGroup: string } | undefined;
}) {
  const gt = useGT();
  const [level, setLevel] = useState<NavigationLevel>(
    props.initialCluster ? { kind: "cluster", ...props.initialCluster } : { kind: "overview" },
  );
  const [knownGroups, setKnownGroups] = useState<Record<string, string[]>>({});
  const [selected, setSelectedId] = useState<string | null>(null);
  const [selectedMemory, setSelectedMemory] = useState<NavigationSummary | null>(null);
  const [query, setQuery] = useState(props.initialSearch ?? "");
  const [debounced, setDebounced] = useState("");
  const [filter, setFilter] = useState<"all" | "available" | "needs-recheck">("all");
  const narrow = useMediaQuery("max-lg");
  const [display, setDisplay] = useState<"graph" | "list" | null>(null);
  const view = display ?? (narrow ? "list" : "graph");
  const [layouts, setLayouts] = useState<Record<string, Positions>>({});
  const [routeStart, setRouteStart] = useState<NavigationSummary | null>(null);
  const [destination, setDestination] = useState<NavigationSummary | null>(null);
  const [returnLevel, setReturnLevel] = useState<NavigationLevel>({ kind: "overview" });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Debounce remote search requests and cancel on unmount.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 200);
    return () => clearTimeout(timer);
  }, [query]);
  const snapshot = useEnvironmentQueryRefresh(
    serverEnvironment.projectMemorySnapshot({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    }),
  );
  const overview = useEnvironmentQuery(
    serverEnvironment.navigationOverview({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    }),
  );
  const search = useNavigationPages({
    ...props,
    query: debounced && debounced === query.trim() ? debounced : undefined,
  });
  const children = useNavigationPages({
    ...props,
    cluster:
      level.kind === "cluster"
        ? {
            environment: level.environment,
            pathGroup: level.pathGroup,
            ...(level.prefix ? { prefix: level.prefix } : {}),
          }
        : undefined,
  });
  const neighborhood = useEnvironmentQuery(
    level.kind === "neighborhood"
      ? serverEnvironment.navigationNeighborhood({
          environmentId: props.environmentId,
          input: { projectId: props.projectId, stateId: level.stateId, limit: 100, filter },
        })
      : null,
  );
  const route = useEnvironmentQuery(
    routeStart && destination
      ? serverEnvironment.navigationRoutePreview({
          environmentId: props.environmentId,
          input: {
            projectId: props.projectId,
            fromStateId: routeStart.id,
            toStateId: destination.id,
          },
        })
      : null,
  );
  const key =
    levelKey(level) + (level.kind === "route" ? `${routeStart?.id}:${destination?.id}` : "");
  const clusters = (overview.data?.clusters ?? []).filter(
    (c) => level.kind !== "overview" || !level.environment || c.environment === level.environment,
  );
  const neighbors = neighborhood.data;
  const routeStates = routeStart
    ? [routeStart, ...(route.data?.steps.map((s) => s.destination) ?? [])]
    : [];
  const states =
    level.kind === "cluster"
      ? children.states
      : level.kind === "route"
        ? routeStates
        : [
            ...new Map(
              [
                ...(neighbors?.state ? [neighbors.state] : []),
                ...(neighbors?.incoming.map((i) => i.state) ?? []),
                ...(neighbors?.outgoing.map((i) => i.state) ?? []),
              ].map((s) => [s.id, s]),
            ).values(),
          ];
  const transitions: readonly NavigationTransition[] =
    level.kind === "cluster"
      ? children.connections
      : level.kind === "route"
        ? (route.data?.steps.map((s) => s.transition) ?? [])
        : [
            ...(neighbors?.incoming.map((i) => i.transition) ?? []),
            ...(neighbors?.outgoing.map((i) => i.transition) ?? []),
          ];
  const visibleTransitions =
    level.kind === "route"
      ? transitions
      : transitions.filter(
          (t) => filter === "all" || (filter === "available" ? t.available : !t.available),
        );
  const warning = new Set(transitions.flatMap((t) => (t.available ? [] : [t.from, t.to])));
  const rows =
    level.kind === "neighborhood"
      ? [
          ...(neighbors?.state
            ? [{ state: neighbors.state, id: neighbors.state.id, column: 1 }]
            : []),
          ...[
            ...new Map((neighbors?.incoming ?? []).map(({ state }) => [state.id, state])).values(),
          ].map((state) => ({ state, id: `incoming:${state.id}`, column: 0 })),
          ...[
            ...new Map((neighbors?.outgoing ?? []).map(({ state }) => [state.id, state])).values(),
          ].map((state) => ({ state, id: `outgoing:${state.id}`, column: 2 })),
        ]
      : states.map((state, index) => ({
          state,
          id: level.kind === "route" ? `step:${index}` : state.id,
          column: 1,
        }));
  const multiHost = new Set(overview.data?.clusters.map((c) => c.environment)).size > 1;
  const subgroupParent =
    level.kind === "cluster" && children.subgroups.length > 0
      ? commonPathParent([
          ...children.subgroups.map((g) => g.prefix),
          ...children.states.map((s) => s.path),
        ])
      : undefined;
  const stateItems: LayoutItem[] = rows.map(({ state, id, column }) => ({
    id,
    stateId: state.id,
    name: state.name,
    fullPath: state.path,
    column,
    kind: "state",
    description: state.path.split("/").filter(Boolean).slice(-2).join("/"),
    warning: state.hasNeedsRecheck || warning.has(state.id),
  }));
  const items: LayoutItem[] =
    level.kind === "overview"
      ? clusters.map((c) => ({
          id: clusterId(c.environment, c.pathGroup),
          name: c.pathGroup,
          environment: c.environment,
          count: c.stateCount,
          kind: "cluster",
          description: `${multiHost ? new URL(c.environment).host + " · " : ""}${gt("{count, plural, one {# screen} other {# screens}} · {connections, plural, one {# connection} other {# connections}}", { count: c.stateCount, connections: c.outgoingCount })}`,
        }))
      : level.kind === "cluster"
        ? [
            ...children.subgroups.map((g): LayoutItem => ({
              id: g.prefix,
              name: relativeSubgroup(g.prefix, subgroupParent ?? level.prefix),
              fullPath: g.prefix,
              kind: "subgroup",
              description: gt("{count, plural, one {# screen} other {# screens}}{suffix}", {
                count: g.stateCount,
                suffix: navigationCountSuffix(g.countCapped),
              }),
            })),
            ...stateItems,
          ]
        : stateItems;
  const edges: Edge[] =
    level.kind === "overview"
      ? (overview.data?.connections ?? []).map((e) => ({
          id: JSON.stringify(e),
          source: clusterId(e.fromEnvironment, e.fromPathGroup),
          target: clusterId(e.toEnvironment, e.toPathGroup),
          label: e.count > 1 ? String(e.count) : undefined,
          style: {
            stroke: "var(--muted-foreground)",
            strokeWidth: e.count > 100 ? 3 : e.count > 10 ? 2 : 1,
          },
        }))
      : visibleTransitions.map((e, index) => ({
          id: `${index}:${e.id}`,
          source:
            level.kind === "route"
              ? `step:${index}`
              : level.kind === "neighborhood" && e.to === neighbors?.state?.id
                ? `incoming:${e.from}`
                : e.from,
          target:
            level.kind === "route"
              ? `step:${index + 1}`
              : level.kind === "neighborhood" && e.from === neighbors?.state?.id
                ? `outgoing:${e.to}`
                : e.to,
          label: e.action.length > 28 ? `${e.action.slice(0, 27)}…` : e.action,
          data: { fullLabel: e.action },
          style: {
            stroke: e.available ? "var(--muted-foreground)" : "var(--warning-foreground)",
            strokeDasharray: e.available ? undefined : "5 4",
          },
        }));
  const layout = navigationLayout(level.kind, items, layouts[key], edges);
  if (items.some((item) => !layouts[key]?.[item.id]))
    setLayouts({ ...layouts, [key]: layout.positions });
  function go(next: NavigationLevel) {
    setLevel(next);
    setSelected(null);
    setQuery("");
  }
  function up() {
    if (query) {
      setQuery("");
      return;
    }
    if (level.kind === "route") go(returnLevel);
    else if (level.kind === "neighborhood")
      go({
        kind: "cluster",
        environment: level.environment,
        pathGroup: level.pathGroup,
        ...(level.prefixes?.length ? { prefix: level.prefixes.at(-1)! } : {}),
      });
    else if (level.kind === "cluster" && level.prefix)
      go({ kind: "cluster", environment: level.environment, pathGroup: level.pathGroup });
    else if (level.kind === "cluster") go({ kind: "overview", environment: level.environment });
    else go({ kind: "overview" });
  }
  const observedGroups =
    level.kind === "cluster"
      ? [
          ...new Set([
            ...(knownGroups[level.environment] ?? []),
            ...(level.prefix ? [level.prefix] : []),
            ...(subgroupParent && relativeSubgroup(subgroupParent) !== "/" ? [subgroupParent] : []),
            ...children.subgroups.map((g) => g.prefix),
          ]),
        ]
      : [];
  if (
    level.kind === "cluster" &&
    observedGroups.length !== (knownGroups[level.environment]?.length ?? 0)
  )
    setKnownGroups({ ...knownGroups, [level.environment]: observedGroups });
  function choose(state: NavigationSummary, asDestination = true) {
    const location = stateLocation(state, knownGroups[state.environment]);
    setQuery("");
    if (routeStart && asDestination) {
      setDestination(state);
      setReturnLevel(level);
      go({
        kind: "route",
        environment: location.environment,
        pathGroup: location.pathGroup,
      });
    } else {
      go({
        kind: "neighborhood",
        ...location,
        stateId: state.id,
        name: state.name,
      });
      setSelected(state.id, state);
    }
  }
  function open(id: string) {
    const c = clusters.find((c) => clusterId(c.environment, c.pathGroup) === id);
    if (level.kind === "overview" && c)
      go({ kind: "cluster", environment: c.environment, pathGroup: c.pathGroup });
    else if (level.kind === "cluster" && children.subgroups.some((g) => g.prefix === id))
      go({ ...level, prefix: id });
    else {
      const state = states.find((s) => s.id === (items.find((i) => i.id === id)?.stateId ?? id));
      if (state) choose(state, false);
    }
  }
  function setSelected(id: string | null, state?: NavigationSummary) {
    setSelectedId(id);
    setSelectedMemory(
      state ?? states.find((s) => s.id === (items.find((i) => i.id === id)?.stateId ?? id)) ?? null,
    );
  }
  // Live refresh restarts cursor pages; the selected screen can belong to a later page.
  const selectedState =
    states.find((s) => s.id === (items.find((i) => i.id === selected)?.stateId ?? selected)) ??
    selectedMemory;
  const detailsRefresh = useEnvironmentQueryRefresh(
    selectedState
      ? serverEnvironment.navigationDetails({
          environmentId: props.environmentId,
          input: { projectId: props.projectId, stateId: selectedState.id },
        })
      : null,
  );
  useNavigationLive(props, (event) => {
    const invalid = navigationInvalidation(event, {
      cluster: level.kind === "cluster" ? level : undefined,
      stateIds: [
        selectedState?.id ?? "",
        ...(level.kind === "neighborhood" ? states.map((state) => state.id) : []),
      ],
    });
    overview.refresh();
    if (invalid.children) children.refresh();
    if (invalid.selection) {
      detailsRefresh.refresh();
      neighborhood.refresh();
      route.refresh();
    }
    if (invalid.search) search.refresh();
  });
  function refresh() {
    detailsRefresh.refresh();
    overview.refresh();
    children.refresh();
    neighborhood.refresh();
    search.refresh();
    route.refresh();
  }
  const error =
    overview.error ?? children.error ?? neighborhood.error ?? search.error ?? route.error;
  const pending =
    level.kind === "overview"
      ? overview.isPending
      : level.kind === "cluster"
        ? children.isPending
        : level.kind === "route"
          ? route.isPending
          : neighborhood.isPending;
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 pb-4"
      onKeyDown={(event) => {
        if (event.key === "Escape" && (level.kind !== "overview" || level.environment || query)) {
          event.preventDefault();
          event.stopPropagation();
          up();
        }
      }}
    >
      <nav
        aria-label={gt("Navigation breadcrumbs")}
        className="my-3 flex flex-wrap items-center gap-1 pr-8"
      >
        <div className="mr-3 shrink-0">
          <DialogTitle>{gt("Navigation explorer")}</DialogTitle>
        </div>
        {level.kind === "overview" && !level.environment ? (
          <span aria-current="page" className="text-sm">
            {gt("Project")}
          </span>
        ) : (
          <Button size="xs" variant="ghost" onClick={() => go({ kind: "overview" })}>
            {gt("Project")}
          </Button>
        )}
        {level.environment && (
          <>
            <ChevronRightIcon className="size-3 text-muted-foreground" />
            {level.kind === "overview" ? (
              <span aria-current="page" className="text-sm">
                {new URL(level.environment).host}
              </span>
            ) : (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => go({ kind: "overview", environment: level.environment! })}
              >
                {new URL(level.environment).host}
              </Button>
            )}
          </>
        )}
        {level.kind !== "overview" && (
          <>
            <ChevronRightIcon className="size-3 text-muted-foreground" />
            {level.kind === "cluster" && !level.prefix ? (
              <span aria-current="page" className="text-sm">
                {level.pathGroup}
              </span>
            ) : (
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  go({
                    kind: "cluster",
                    environment: level.environment,
                    pathGroup: level.pathGroup,
                  })
                }
              >
                {level.pathGroup}
              </Button>
            )}
          </>
        )}
        {(level.kind === "neighborhood"
          ? (level.prefixes ?? [])
          : level.kind === "cluster" && level.prefix
            ? stateLocation({ environment: level.environment, path: level.prefix }, [
                ...new Set([...(knownGroups[level.environment] ?? []), level.prefix]),
              ]).prefixes
            : []
        ).map((prefix, index, prefixes) => (
          <Tooltip key={prefix}>
            <TooltipTrigger
              render={
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() =>
                    go({
                      kind: "cluster",
                      environment: level.environment!,
                      pathGroup: level.kind === "overview" ? "/" : level.pathGroup,
                      prefix,
                    })
                  }
                />
              }
            >
              › {relativeSubgroup(prefix, prefixes[index - 1])}
            </TooltipTrigger>
            <TooltipPopup>{prefix}</TooltipPopup>
          </Tooltip>
        ))}
        {level.kind === "neighborhood" && (
          <span aria-current="page" className="truncate text-sm">
            › {level.name}
          </span>
        )}
      </nav>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="min-w-40 flex-1">
          <Autocomplete
            items={search.states}
            filter={null}
            value={query}
            onValueChange={setQuery}
            itemToStringValue={(s: NavigationSummary) => s.name}
          >
            <AutocompleteInput
              maxLength={160}
              aria-label={gt("Search navigation")}
              placeholder={gt("Search navigation")}
            />
            <AutocompletePopup>
              <AutocompleteEmpty>{gt("No states found.")}</AutocompleteEmpty>
              <AutocompleteList>
                {(state: NavigationSummary) => (
                  <AutocompleteItem key={state.id} value={state} onClick={() => choose(state)}>
                    <div>
                      <div>{state.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {state.environment} · {state.path}
                      </div>
                    </div>
                  </AutocompleteItem>
                )}
              </AutocompleteList>
            </AutocompletePopup>
          </Autocomplete>
        </div>
        <ToggleGroup
          aria-label={gt("Connection filter")}
          value={[filter]}
          onValueChange={(values) => {
            const next = values[0];
            if (next === "all" || next === "available" || next === "needs-recheck") setFilter(next);
          }}
        >
          <Toggle value="all">{gt("All")}</Toggle>
          <Toggle value="available">{gt("Available")}</Toggle>
          <Toggle value="needs-recheck">{gt("Needs recheck")}</Toggle>
        </ToggleGroup>
        <ToggleGroup
          aria-label={gt("Navigation display")}
          value={[view]}
          onValueChange={(values) => {
            if (values[0] === "graph" || values[0] === "list") setDisplay(values[0]);
          }}
        >
          <Toggle value="graph">{gt("Graph")}</Toggle>
          <Toggle value="list">{gt("List")}</Toggle>
        </ToggleGroup>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button size="icon-sm" variant="ghost" aria-label={gt("Refresh")} onClick={refresh} />
            }
          >
            <RefreshCwIcon />
          </TooltipTrigger>
          <TooltipPopup>{gt("Refresh")}</TooltipPopup>
        </Tooltip>
      </div>
      {routeStart && (
        <section className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm">
          <span>
            {destination
              ? gt("Route: {from} → {to} · {count, plural, one {# step} other {# steps}}", {
                  from: routeStart.name,
                  to: destination.name,
                  count: route.data?.steps.length ?? 0,
                })
              : gt("Route from {name}: choose a destination", { name: routeStart.name })}
          </span>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              setRouteStart(null);
              setDestination(null);
              if (level.kind === "route") go(returnLevel);
            }}
          >
            {gt("Clear route")}
          </Button>
          {level.kind === "route" && (
            <Button size="xs" variant="outline" onClick={up}>
              {gt("Back")}
            </Button>
          )}
          {route.data?.status === "no-route" && <p>{gt("No route found.")}</p>}
          {route.data?.status === "budget-exhausted" && (
            <p>{gt("Search stopped before finding a route; the map may still have one")}</p>
          )}
          {route.data?.status === "already-there" && <p>{gt("Already at the destination.")}</p>}
          {route.data?.status === "found" && (
            <ol className="w-full list-inside list-decimal text-xs text-muted-foreground">
              {route.data.steps.map((s) => (
                <li key={s.transition.id}>
                  {s.transition.action} → {s.destination.name}
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-background lg:flex-row">
        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {error && (
            <p role="alert" className="p-3 text-sm">
              {error}
            </p>
          )}
          {pending && items.length === 0 ? (
            <div className="grid grid-cols-3 gap-4 p-6">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-14 w-52" />
              ))}
            </div>
          ) : view === "graph" ? (
            <NavigationCanvas
              levelId={key}
              items={layout.items}
              positions={layout.positions}
              edges={edges.filter(
                (e) => items.some((i) => i.id === e.source) && items.some((i) => i.id === e.target),
              )}
              selected={selected}
              highlighted={new Set(level.kind === "route" ? states.map((s) => s.id) : [])}
              onSelect={setSelected}
              onOpen={open}
              canGoUp={level.kind !== "overview" || !!level.environment}
              onUp={up}
            />
          ) : (
            <ScrollArea>
              <Table aria-label={gt("Navigation list")}>
                <TableHeader>
                  <TableRow>
                    <TableHead>{gt("Name")}</TableHead>
                    <TableHead>
                      {level.kind === "overview" || children.subgroups.length
                        ? gt("Screens")
                        : gt("Path")}
                    </TableHead>
                    {level.kind !== "overview" && !children.subgroups.length && (
                      <>
                        <TableHead>{gt("Incoming")}</TableHead>
                        <TableHead>{gt("Outgoing")}</TableHead>
                      </>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {layout.items.map((item) => (
                    <TableRow
                      key={item.id}
                      tabIndex={0}
                      aria-selected={selected === item.id}
                      onClick={() => setSelected(item.id)}
                      onDoubleClick={() => open(item.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") open(item.id);
                      }}
                    >
                      <TableCell>{item.kind === "subgroup" ? item.fullPath : item.name}</TableCell>
                      <TableCell>
                        {item.kind === "state" ? item.fullPath : item.description}
                      </TableCell>
                      {level.kind !== "overview" && !children.subgroups.length && (
                        <>
                          <TableCell>
                            {states.find((s) => s.id === item.stateId)?.incomingCount ?? 0}
                          </TableCell>
                          <TableCell>
                            {states.find((s) => s.id === item.stateId)?.outgoingCount ?? 0}
                          </TableCell>
                        </>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {visibleTransitions.length > 0 && (
                <Table aria-label={gt("Connections")}>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{gt("From")}</TableHead>
                      <TableHead>{gt("To")}</TableHead>
                      <TableHead>{gt("Action")}</TableHead>
                      <TableHead>{gt("Status")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...new Map(visibleTransitions.map((edge) => [edge.id, edge])).values()].map(
                      (edge) => (
                        <TableRow
                          key={edge.id}
                          tabIndex={0}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              const state = states.find((s) => s.id === edge.to);
                              if (state) choose(state, false);
                            }
                          }}
                        >
                          <TableCell>{states.find((s) => s.id === edge.from)?.name}</TableCell>
                          <TableCell>{states.find((s) => s.id === edge.to)?.name}</TableCell>
                          <TableCell>{edge.action}</TableCell>
                          <TableCell>
                            {edge.available ? gt("Available") : gt("Needs recheck")}
                          </TableCell>
                        </TableRow>
                      ),
                    )}
                  </TableBody>
                </Table>
              )}
            </ScrollArea>
          )}
          {!pending && items.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <Empty>
                <EmptyDescription>{gt("No states found.")}</EmptyDescription>
              </Empty>
            </div>
          )}
          {level.kind === "cluster" && children.data?.nextCursor && (
            <Button
              size="sm"
              variant="outline"
              disabled={children.isPending}
              onClick={children.loadMore}
            >
              {gt("Load more")}
            </Button>
          )}
          {(children.data?.truncated || children.connectionsTruncated) && (
            <p role="status" className="p-2 text-xs text-muted-foreground">
              {gt("More records exist than are shown.")}
            </p>
          )}
        </main>
        <div className="max-h-[40%] w-full shrink-0 border-t lg:h-full lg:max-h-none lg:w-80 lg:border-t-0 lg:border-l">
          {selectedState ? (
            <NavigationDetailsPanel
              key={selectedState.id}
              {...props}
              stateId={selectedState.id}
              onRouteFrom={() => {
                setRouteStart(selectedState);
                setDestination(null);
              }}
              onDeleted={() => {
                snapshot.refresh();
                refresh();
                setRouteStart(null);
                setDestination(null);
                go({ kind: "overview" });
              }}
            />
          ) : (
            <Empty size="compact">
              <EmptyDescription>
                {gt("Select a screen to see how it is recognized and reached")}
              </EmptyDescription>
            </Empty>
          )}
        </div>
      </div>
    </div>
  );
}
