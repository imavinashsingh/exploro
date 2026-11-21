import type { NavigationRevision, NavigationState, NavigationSummary } from "@t3tools/contracts";
import { msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

export function navigationInvalidation(
  event: NavigationRevision,
  loaded: {
    cluster?: { environment: string; pathGroup: string } | undefined;
    stateIds?: readonly string[] | undefined;
  },
) {
  return {
    overview: true,
    children:
      event.all ||
      event.clusters.some(
        (c) =>
          c.environment === loaded.cluster?.environment && c.pathGroup === loaded.cluster.pathGroup,
      ),
    selection: event.all || (loaded.stateIds ?? []).some((id) => event.stateIds.includes(id)),
    search: event.all,
  };
}

export function recognitionCheckLabel(check: NavigationState["checks"][number], m: MFunctionType) {
  switch (check.kind) {
    case "textVisible":
      return m(msg("Text visible · {text}"), { text: check.text });
    case "urlIncludes":
      return m(msg("URL includes · {value}"), { value: check.value });
    case "elementVisible":
      return m(msg("Element visible · {target}"), { target: check.target.display });
    case "valueEquals":
      return m(msg("Value equals · {target} = {value}"), {
        target: check.target.display,
        value: check.value,
      });
  }
}

export function navigationTotals(
  clusters: readonly { stateCount: number; outgoingCount: number }[],
) {
  return clusters.reduce(
    (total, c) => ({
      screens: total.screens + c.stateCount,
      connections: total.connections + c.outgoingCount,
    }),
    { screens: 0, connections: 0 },
  );
}

export function stateLocation(
  state: { environment: string; path: string },
  knownPrefixes: readonly string[] = [],
) {
  const segments = state.path.split(/[?#]/u)[0]!.split("/").filter(Boolean);
  const controller = segments.findIndex((segment) => segment.includes("."));
  const pathGroup = `/${segments[controller + 1] ?? ""}`;
  const prefixes = knownPrefixes
    .filter(
      (prefix) => state.path.split(/[?#]/u)[0] === prefix || state.path.startsWith(`${prefix}/`),
    )
    .sort((a, b) => a.length - b.length);
  return { environment: state.environment, pathGroup, prefixes };
}
export function relativeSubgroup(prefix: string, parent?: string) {
  if (parent && prefix.startsWith(`${parent}/`)) return prefix.slice(parent.length);
  const segments = prefix.split("/").filter(Boolean);
  const controller = segments.findIndex((segment) => segment.includes("."));
  return `/${segments.slice(controller + 2).join("/")}`;
}

export function commonPathParent(paths: readonly string[]) {
  if (paths.length < 2) return undefined;
  const segments = paths[0]!.split(/[?#]/u)[0]!.split("/");
  const length = paths.reduce((length, path) => {
    const other = path.split(/[?#]/u)[0]!.split("/");
    let i = 0;
    while (i < length && segments[i] === other[i]) i++;
    return i;
  }, segments.length);
  return segments.slice(0, length).join("/") || "/";
}

export function mergeNavigationStates(
  previous: readonly NavigationSummary[],
  current: readonly NavigationSummary[],
) {
  return [...new Map([...previous, ...current].map((state) => [state.id, state])).values()];
}

export function navigationCountSuffix(capped: boolean | undefined) {
  return capped ? "+" : "";
}
