import type { NavigationState, NavigationTransition } from "@t3tools/contracts";

const orderedContext = (context: Readonly<Record<string, string>>) =>
  Object.entries(context).sort(([a], [b]) => a.localeCompare(b));
export function navigationStateKey(state: Omit<NavigationState, "id">): string {
  return JSON.stringify([
    state.environment,
    state.path,
    orderedContext(state.context),
    state.checks.map((check) => JSON.stringify(check)).sort(),
  ]);
}

function navigationContextMatches(
  required: Readonly<Record<string, string>>,
  actual: Readonly<Record<string, string>>,
): boolean {
  return Object.entries(required).every(([key, value]) => actual[key] === value);
}

export function findNavigationPath(
  states: ReadonlyArray<NavigationState>,
  transitions: ReadonlyArray<NavigationTransition>,
  from: string,
  to: string,
  context: Readonly<Record<string, string>>,
): ReadonlyArray<NavigationTransition> | null {
  const known = new Map(states.map((state) => [state.id, state]));
  if (!known.has(from) || !known.has(to)) return null;
  const key = (id: string, value: Readonly<Record<string, string>>) =>
    JSON.stringify([id, orderedContext(value)]);
  const visited = new Set([key(from, context)]);
  const outgoing = new Map<string, NavigationTransition[]>();
  for (const edge of transitions) {
    const edges = outgoing.get(edge.from) ?? [];
    edges.push(edge);
    outgoing.set(edge.from, edges);
  }
  const queue: Array<{
    id: string;
    path: ReadonlyArray<NavigationTransition>;
    context: Readonly<Record<string, string>>;
  }> = [{ id: from, path: [], context }];
  for (let index = 0; index < queue.length && index < 1000; index += 1) {
    const current = queue[index]!;
    if (current.id === to) return current.path;
    if (current.path.length >= 50) continue;
    for (const edge of outgoing.get(current.id) ?? []) {
      if (
        !edge.available ||
        !known.has(edge.to) ||
        !navigationContextMatches(edge.conditions, current.context)
      )
        continue;
      const nextContext = { ...current.context, ...known.get(edge.to)!.context };
      const nextKey = key(edge.to, nextContext);
      if (visited.has(nextKey)) continue;
      visited.add(nextKey);
      queue.push({ id: edge.to, path: [...current.path, edge], context: nextContext });
    }
  }
  return null;
}

const fillerWords = new Set([
  "the",
  "for",
  "and",
  "that",
  "with",
  "from",
  "can",
  "into",
  "this",
  "page",
  "screen",
  "view",
]);
// Word forms match ("add"/"adding", "tracked"/"tracking"); a short word does not match any long one.
const sameWord = (a: string, b: string) => {
  if (a.length < 3 || b.length < 3 || /\p{N}/u.test(a + b)) return a === b;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return (
    (long.startsWith(short) && long.length - short.length <= 3) ||
    (short.length >= 5 && long.startsWith(short.slice(0, 5)))
  );
};

export function isExactNavigationDestination(state: NavigationState, query: string) {
  const normalized = query.trim().toLowerCase();
  return [state.id, state.name, ...state.aliases].some((name) => name.toLowerCase() === normalized);
}

export function navigationDestinations(
  states: ReadonlyArray<NavigationState>,
  query: string,
): ReadonlyArray<NavigationState> {
  const normalized = query.trim().toLowerCase();
  const exact = states.filter((state) => isExactNavigationDestination(state, normalized));
  if (exact.length > 0) return exact;
  // Requests name features loosely ("my personal details editor"); the closest remembered names win.
  const tokens = (text: string) =>
    [...new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u))].filter(
      (word) => (word.length >= 3 || /\p{N}/u.test(word)) && !fillerWords.has(word),
    );
  const words = tokens(normalized);
  const numbers = words.filter((word) => /\p{N}/u.test(word));
  const scored = states.flatMap((s) => {
    const names = tokens(`${s.name} ${s.aliases.join(" ")}`);
    if (names.some((name) => /\p{N}/u.test(name)) && !numbers.every((word) => names.includes(word)))
      return [];
    return [
      { s, score: words.filter((word) => names.some((name) => sameWord(word, name))).length },
    ];
  });
  const best = Math.max(0, ...scored.map((entry) => entry.score));
  return best === 0 ? [] : scored.filter((entry) => entry.score === best).map((entry) => entry.s);
}

export const navigationTransitionKey = (from: string, to: string, action: string) =>
  JSON.stringify([from, to, action]);
