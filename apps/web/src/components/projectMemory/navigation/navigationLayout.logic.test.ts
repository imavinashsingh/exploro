import { describe, expect, it } from "vite-plus/test";
import {
  navigationLayout,
  stateLocation,
  relativeSubgroup,
  commonPathParent,
} from "./navigationLayout.logic";

describe("navigation layout", () => {
  it("layers by shortest depth and puts unreachable cycles in the final column", () => {
    const items = ["D", "C", "B", "A", "Y", "Z"].map((id) => ({ id, name: id }));
    const edges = [
      { source: "A", target: "B" },
      { source: "B", target: "C" },
      { source: "A", target: "C" },
      { source: "Y", target: "Z" },
      { source: "Z", target: "Y" },
    ];
    const first = navigationLayout("cluster", items, {}, edges);
    expect(first.positions.A!.x).toBe(0);
    expect(first.positions.B!.x).toBe(300);
    expect(first.positions.C!.x).toBe(300);
    expect(first.positions.Y!.x).toBe(600);
    expect(navigationLayout("cluster", [...items].reverse(), {}, edges)).toEqual(first);
    const refreshed = navigationLayout(
      "cluster",
      [...items, { id: "new", name: "new" }],
      first.positions,
      edges,
    );
    for (const item of items)
      expect(refreshed.positions[item.id]).toEqual(first.positions[item.id]);
  });
  it("keeps routes in step order and wraps tall neighborhood columns", () => {
    const route = navigationLayout("route", [
      { id: "b", name: "B" },
      { id: "a", name: "A" },
    ]);
    expect(route.positions.b).toEqual({ x: 0, y: 0 });
    expect(route.positions.a).toEqual({ x: 460, y: 0 });
    const items = Array.from({ length: 14 }, (_, i) => ({
      id: String(i),
      name: String(i).padStart(2, "0"),
      column: 0,
    }));
    const layout = navigationLayout("neighborhood", items);
    expect(layout.positions["12"]).toEqual({ x: 250, y: 0 });
    expect(Math.max(...Object.values(layout.positions).map((p) => p.y))).toBe(990);
  });
  it("grids isolated states beside the connected layers when fewer than half are connected", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      name: String(i).padStart(2, "0"),
    }));
    const empty = navigationLayout("cluster", items);
    expect(new Set(Object.values(empty.positions).map((p) => p.x)).size).toBe(6);
    expect(Math.max(...Object.values(empty.positions).map((p) => p.y))).toBe(270);
    const mixed = navigationLayout("cluster", items, {}, [{ source: "0", target: "1" }]);
    expect(mixed.positions["0"]!.x).toBe(0);
    expect(mixed.positions["1"]!.x).toBe(300);
    for (const item of items.slice(2)) expect(mixed.positions[item.id]!.x).toBeGreaterThan(300);
  });
  it("orders overview by environment then count in separate rows", () => {
    const layout = navigationLayout("overview", [
      { id: "a", name: "a", environment: "one", count: 1 },
      { id: "b", name: "b", environment: "one", count: 2 },
      { id: "c", name: "c", environment: "two", count: 5 },
    ]);
    expect(layout.items.map((item) => item.id)).toEqual(["b", "a", "c"]);
    expect(layout.positions.b!.x).toBe(0);
    expect(layout.positions.a!.x).toBe(260);
    expect(layout.positions.c!.y).toBeGreaterThan(layout.positions.a!.y);
  });
});

describe("navigation locations", () => {
  it("derives the state’s own environment and controller group, retaining only matching subgroup ancestors", () => {
    const prefixes = ["/web/index.php/pim/viewEmployee/contact", "/web/index.php/pim/viewEmployee"];
    expect(
      stateLocation(
        { environment: "https://other.test", path: "/web/index.php/dashboard/index" },
        prefixes,
      ),
    ).toEqual({ environment: "https://other.test", pathGroup: "/dashboard", prefixes: [] });
    expect(
      stateLocation(
        {
          environment: "https://hrm.test",
          path: "/web/index.php/pim/viewEmployee/contact/empNumber/1",
        },
        prefixes,
      ).prefixes,
    ).toEqual([...prefixes].reverse());
    expect(
      stateLocation({ environment: "https://other.test", path: "/dashboard?next=/pim" }).pathGroup,
    ).toBe("/dashboard");
    expect(relativeSubgroup("/web/index.php/pim/viewEmployee")).toBe("/viewEmployee");
    expect(relativeSubgroup(prefixes[0]!, prefixes[1])).toBe("/contact");
    const siblings = [prefixes[0]!, "/web/index.php/pim/viewEmployee/job"];
    expect(relativeSubgroup(siblings[0]!, commonPathParent(siblings))).toBe("/contact");
  });
});
