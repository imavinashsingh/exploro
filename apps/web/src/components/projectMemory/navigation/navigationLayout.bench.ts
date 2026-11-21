import { describe, test } from "vite-plus/test";
import { clusterId, navigationLayout, type LayoutItem } from "./navigationLayout.logic.ts";

// Payload sizes are the RPC caps: overview 200 clusters, children 200 states + 500
// connections, neighborhood 100 incoming + 100 outgoing.
const clusters: LayoutItem[] = Array.from({ length: 200 }, (_, i) => ({
  id: clusterId(`https://hr-${i % 2}.example.test`, `/module${i}`),
  name: `/module${i}`,
  environment: `https://hr-${i % 2}.example.test`,
  count: 1000 - i,
  kind: "cluster",
}));
const clusterEdges = Array.from({ length: 200 }, (_, i) => ({
  source: clusters[i]!.id,
  target: clusters[(i * 7 + 3) % 200]!.id,
}));
const states: LayoutItem[] = Array.from({ length: 200 }, (_, i) => ({
  id: `state-${i}`,
  stateId: `state-${i}`,
  name: `Employee ${i}`,
  kind: "state",
}));
const stateEdges = Array.from({ length: 500 }, (_, i) => ({
  source: `state-${i % 200}`,
  target: `state-${(i * 13 + 1 + Math.floor(i / 200)) % 200}`,
}));
const neighbors: LayoutItem[] = [
  { id: "center", stateId: "center", name: "Center", column: 1, kind: "state" },
  ...Array.from({ length: 100 }, (_, i) => ({
    id: `in-${i}`,
    stateId: `in-${i}`,
    name: `Incoming ${i}`,
    column: 0,
    kind: "state" as const,
  })),
  ...Array.from({ length: 100 }, (_, i) => ({
    id: `out-${i}`,
    stateId: `out-${i}`,
    name: `Outgoing ${i}`,
    column: 2,
    kind: "state" as const,
  })),
];
const neighborEdges = neighbors
  .slice(1)
  .map((item) =>
    item.column === 0
      ? { source: item.id, target: "center" }
      : { source: "center", target: item.id },
  );

describe("navigation layout", () => {
  test("overview: 200 clusters + 200 edges", async ({ bench }) => {
    await bench("layout", () => {
      navigationLayout("overview", clusters, {}, clusterEdges);
    }).run();
  });
  test("cluster: 200 states + 500 connections", async ({ bench }) => {
    await bench("layout", () => {
      navigationLayout("cluster", states, {}, stateEdges);
    }).run();
  });
  test("neighborhood: 100 incoming + 100 outgoing", async ({ bench }) => {
    await bench("layout", () => {
      navigationLayout("neighborhood", neighbors, {}, neighborEdges);
    }).run();
  });
});
