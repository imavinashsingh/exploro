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

function countBy<T>(values: readonly T[], key: (value: T) => string | number) {
  const counts = new Map<string | number, number>();
  for (const value of values) counts.set(key(value), (counts.get(key(value)) ?? 0) + 1);
  return counts;
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
  // Route positions come from step order alone; kept cells from another route would block them.
  const kept = kind === "route" ? {} : previous;
  const positions: Record<string, Position> = { ...kept };
  const occupied = new Set(Object.values(kept).map((p) => `${p.x}:${p.y}`));
  const depth = new Map<string, number>();
  let isolated = new Set<string>();
  let gridStart = 0;
  if (kind === "cluster") {
    const ids = new Set(items.map((item) => item.id));
    const internal = edges.filter((e) => ids.has(e.source) && ids.has(e.target));
    const connected = new Set(internal.flatMap((e) => [e.source, e.target]));
    if (connected.size < items.length / 2)
      isolated = new Set(sorted.filter((item) => !connected.has(item.id)).map((item) => item.id));
    const incoming = new Set(internal.map((e) => e.target));
    const queue = sorted
      .filter((item) => !incoming.has(item.id) && !isolated.has(item.id))
      .map((item) => item.id);
    const outgoing = new Map<string, Array<(typeof internal)[number]>>();
    for (const edge of internal) {
      const list = outgoing.get(edge.source);
      if (list) list.push(edge);
      else outgoing.set(edge.source, [edge]);
    }
    for (const id of queue) depth.set(id, 0);
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i]!;
      for (const edge of outgoing.get(id) ?? []) {
        if (!depth.has(edge.target)) {
          depth.set(edge.target, depth.get(id)! + 1);
          queue.push(edge.target);
        }
      }
    }
    const final = Math.max(0, ...depth.values()) + 1;
    for (const item of sorted)
      if (!depth.has(item.id) && !isolated.has(item.id)) depth.set(item.id, final);
    gridStart = depth.size ? (Math.max(...depth.values()) + 1) * 300 : 0;
  }
  const environments = [...new Set(sorted.map((item) => item.environment ?? ""))];
  const environmentHeight =
    Math.ceil(Math.max(0, ...countBy(sorted, (item) => item.environment ?? "").values()) / 4) *
      100 +
    80;
  const columnCounts = countBy(items, (item) => item.column ?? 1);
  const columnX = (column: number) =>
    Array.from(
      { length: column },
      (_, col) => Math.max(1, Math.ceil((columnCounts.get(col) ?? 0) / 12)) * 250 + 50,
    ).reduce((sum, width) => sum + width, 0);
  const isolatedColumns = Math.ceil(Math.sqrt(isolated.size * 1.6));
  // Occupied cells only accumulate, so each lane's lowest free slot never moves backwards.
  const nextSlot = new Map<string, number>();
  for (const [index, item] of sorted.entries()) {
    if (positions[item.id]) continue;
    const lane =
      kind === "overview"
        ? `e${item.environment ?? ""}`
        : kind === "neighborhood"
          ? `c${item.column ?? 1}`
          : isolated.has(item.id)
            ? "isolated"
            : `d${depth.get(item.id) ?? 0}`;
    let slot = nextSlot.get(lane) ?? 0;
    let position: Position;
    do {
      if (kind === "route") position = { x: index * 460, y: 0 };
      else if (kind === "overview")
        position = {
          x: (slot % 4) * 260,
          y:
            environments.indexOf(item.environment ?? "") * environmentHeight +
            Math.floor(slot / 4) * 100,
        };
      else if (kind === "neighborhood")
        position = {
          x: columnX(item.column ?? 1) + Math.floor(slot / 12) * 250,
          y: (slot % 12) * 90,
        };
      else if (isolated.has(item.id))
        position = {
          x: gridStart + (slot % isolatedColumns) * 260,
          y: Math.floor(slot / isolatedColumns) * 90,
        };
      else position = { x: (depth.get(item.id) ?? 0) * 300, y: slot * 90 };
      slot++;
    } while (occupied.has(`${position.x}:${position.y}`));
    nextSlot.set(lane, slot);
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
