import { describe, expect, it } from "vite-plus/test";
import {
  navigationInvalidation,
  navigationTotals,
  stateLocation,
  relativeSubgroup,
  commonPathParent,
} from "./projectNavigation.ts";

describe("navigation revision invalidation", () => {
  const cluster = { environment: "https://shop.test", pathGroup: "/orders" };
  it.each([
    { all: false, clusters: [], stateIds: [], children: false, selection: false, search: false },
    {
      all: false,
      clusters: [cluster],
      stateIds: [],
      children: true,
      selection: false,
      search: false,
    },
    {
      all: false,
      clusters: [{ ...cluster, environment: "https://other.test" }],
      stateIds: ["neighbor"],
      children: false,
      selection: true,
      search: false,
    },
    { all: true, clusters: [], stateIds: [], children: true, selection: true, search: true },
  ])("invalidates only touched queries: %j", ({ children, selection, search, ...hint }) => {
    expect(
      navigationInvalidation(
        { revision: 1, ...hint },
        { cluster, stateIds: ["selected", "neighbor"] },
      ),
    ).toEqual({ overview: true, children, selection, search });
  });
  it("derives cluster totals and breadcrumbs", () => {
    expect(
      navigationTotals([
        { stateCount: 2, outgoingCount: 3 },
        { stateCount: 4, outgoingCount: 1 },
      ]),
    ).toEqual({ screens: 6, connections: 4 });
    expect(
      stateLocation({ environment: "https://shop.test", path: "/index.php/orders/new" }, [
        "/index.php/orders",
      ]),
    ).toEqual({
      environment: "https://shop.test",
      pathGroup: "/orders",
      prefixes: ["/index.php/orders"],
    });
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
