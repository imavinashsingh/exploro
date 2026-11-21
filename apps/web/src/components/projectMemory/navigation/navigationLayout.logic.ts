export type LayoutItem = {
  id: string;
  stateId?: string;
  name: string;
  description?: string;
  fullPath?: string;
  environment?: string;
  count?: number;
  column?: number;
  kind?: "cluster" | "subgroup" | "state";
  warning?: boolean;
};
export type Position = { x: number; y: number };
export type Positions = Readonly<Record<string, Position>>;
export type NavigationLevel =
  | { kind: "overview"; environment?: string }
  | { kind: "cluster"; environment: string; pathGroup: string; prefix?: string }
  | { kind: "route"; environment: string; pathGroup: string }
  | {
      kind: "neighborhood";
      environment: string;
      pathGroup: string;
      stateId: string;
      name: string;
      prefixes?: string[];
    };
export function clusterId(environment: string, pathGroup: string) {
  return JSON.stringify([environment, pathGroup]);
}
export function levelKey(level: NavigationLevel) {
  return JSON.stringify(level);
}

export function navigationLayout(
  kind: NavigationLevel["kind"],
  items: readonly LayoutItem[],
  previous: Positions = {},
  edges: readonly { source: string; target: string }[] = [],
) {
  const sorted =
    kind === "route"
      ? [...items]
      : [...items].sort(
          (a, b) =>
            (kind === "overview"
              ? (a.environment ?? "").localeCompare(b.environment ?? "") ||
                (b.count ?? 0) - (a.count ?? 0)
              : 0) ||
            a.name.localeCompare(b.name) ||
            a.id.localeCompare(b.id),
        );
  const positions: Record<string, Position> = { ...previous };
  const occupied = new Set(Object.values(previous).map((p) => `${p.x}:${p.y}`));
  const depth = new Map<string, number>();
  let isolated: string[] = [];
  let gridStart = 0;
  if (kind === "cluster") {
    const ids = new Set(items.map((item) => item.id));
    const internal = edges.filter((e) => ids.has(e.source) && ids.has(e.target));
    const connected = new Set(internal.flatMap((e) => [e.source, e.target]));
    if (connected.size < items.length / 2)
      isolated = sorted.filter((item) => !connected.has(item.id)).map((item) => item.id);
    const incoming = new Set(internal.map((e) => e.target));
    const queue = sorted
      .filter((item) => !incoming.has(item.id) && !isolated.includes(item.id))
      .map((item) => item.id);
    for (const id of queue) depth.set(id, 0);
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i]!;
      for (const edge of internal.filter((edge) => edge.source === id)) {
        if (!depth.has(edge.target)) {
          depth.set(edge.target, depth.get(id)! + 1);
          queue.push(edge.target);
        }
      }
    }
    const final = Math.max(0, ...depth.values()) + 1;
    for (const item of sorted)
      if (!depth.has(item.id) && !isolated.includes(item.id)) depth.set(item.id, final);
    gridStart = depth.size ? (Math.max(...depth.values()) + 1) * 300 : 0;
  }
  const environments = [...new Set(sorted.map((item) => item.environment ?? ""))];
  for (const [index, item] of sorted.entries()) {
    if (positions[item.id]) continue;
    let slot = 0;
    let position: Position;
    do {
      if (kind === "route") position = { x: index * 460, y: 0 };
      else if (kind === "overview")
        position = {
          x: (slot % 4) * 260,
          y:
            environments.indexOf(item.environment ?? "") *
              (Math.ceil(
                Math.max(
                  ...environments.map(
                    (env) => sorted.filter((s) => (s.environment ?? "") === env).length,
                  ),
                ) / 4,
              ) *
                100 +
                80) +
            Math.floor(slot / 4) * 100,
        };
      else if (kind === "neighborhood")
        position = {
          x:
            Array.from(
              { length: item.column ?? 1 },
              (_, col) =>
                Math.max(1, Math.ceil(items.filter((i) => (i.column ?? 1) === col).length / 12)) *
                  250 +
                50,
            ).reduce((sum, width) => sum + width, 0) +
            Math.floor(slot / 12) * 250,
          y: (slot % 12) * 90,
        };
      else if (isolated.includes(item.id)) {
        const columns = Math.ceil(Math.sqrt(isolated.length * 1.6));
        position = { x: gridStart + (slot % columns) * 260, y: Math.floor(slot / columns) * 90 };
      } else position = { x: (depth.get(item.id) ?? 0) * 300, y: slot * 90 };
      slot++;
    } while (occupied.has(`${position.x}:${position.y}`));
    positions[item.id] = position;
    occupied.add(`${position.x}:${position.y}`);
  }
  const ordered =
    kind === "route" || kind === "overview"
      ? sorted
      : sorted.toSorted(
          (a, b) =>
            positions[a.id]!.x - positions[b.id]!.x || positions[a.id]!.y - positions[b.id]!.y,
        );
  return { items: ordered, positions };
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
    .toSorted((a, b) => a.length - b.length);
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
