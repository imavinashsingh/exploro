import { describe, expect, it } from "@effect/vitest";

import { findNavigationPath, navigationDestinations, navigationStateKey } from "./navigation.ts";
import { navigationPathGroup } from "./navigationStorage.ts";
import { navigationRoute } from "./ProjectNavigationMemory.ts";

const state = (id: string, context: Record<string, string> = {}) => ({
  id,
  name: id,
  aliases: [],
  environment: "https://app.test",
  path: "/shared",
  context,
  checks: [{ kind: "textVisible" as const, text: id }],
});
const edge = (id: string, from: string, to: string, conditions: Record<string, string> = {}) => ({
  id,
  from,
  to,
  action: id,
  conditions,
  runId: "run-1",
  threadId: "thread-1",
  observedAt: "2026-11-19T00:00:00Z",
  available: true,
});

describe("navigation routing", () => {
  it("groups URL paths without changing screen identities", () => {
    for (const [path, expected] of [
      ["/", "/"],
      ["", "/"],
      ["///", "/"],
      ["/pim/viewEmployee/1", "/pim"],
      ["/pim/", "/pim"],
      ["/web/index.php/pim/x", "/pim"],
      ["/index.php/admin/x", "/admin"],
      ["/app/settings", "/app"],
      ["/web/index.php", "/"],
      ["/pim?tab=1", "/pim"],
      ["/pim#details", "/pim"],
      ["/?query=1#top", "/"],
      ["/pim%2Fview/1", "/pim%2Fview"],
    ])
      expect(navigationPathGroup(path!)).toBe(expected);
  });
  it("matches loosely worded destinations to the closest remembered names", () => {
    const states = [
      ...["Personal Details", "Contact Details", "Candidates", "Add Candidate"].map((name) => ({
        ...state(name),
        name,
      })),
      { ...state("Customers"), aliases: ["Clients for time tracking"] },
      { ...state("Recruitment Candidates"), aliases: ["Candidates list"] },
      state("Employee List"),
      { ...state("Edit Profile"), aliases: ["Profile editor"] },
      state("Contact Form"),
      state("Leave List"),
      state("Employee Directory"),
      state("Settings"),
      state("Go to cart"),
      state("Example 1"),
      state("Example 20"),
    ];
    const names = (query: string) => navigationDestinations(states, query).map((s) => s.name);
    expect(names("my personal details editor")).toEqual(["Personal Details"]);
    expect(names("the form for adding a candidate")).toEqual(["Add Candidate"]);
    expect(names("candidate")).toEqual(["Candidates", "Add Candidate", "Recruitment Candidates"]);
    expect(names("list of clients that employee time can be tracked against")).toEqual([
      "Customers",
    ]);
    expect(names("details")).toEqual(["Personal Details", "Contact Details"]);
    expect(names("billing")).toEqual([]);
    for (const [query, expected] of [
      ["employee list page", ["Employee List"]],
      ["edit profile page", ["Edit Profile"]],
      ["contact form page", ["Contact Form"]],
      ["leave list page", ["Leave List"]],
      ["profile editor page", ["Edit Profile"]],
      ["employee directory", ["Employee Directory"]],
      ["go to settings", ["Settings"]],
      ["Example 2", []],
    ] as const) {
      expect.soft(names(query), query).toEqual(expected);
    }
  });

  it("composes separately observed paths, handles cycles and filters role conditions", () => {
    const states = [state("login"), state("dashboard"), state("list"), state("form")];
    const transitions = [
      edge("sign in", "login", "dashboard"),
      edge("applications", "dashboard", "list"),
      edge("new", "list", "form", { role: "creator" }),
      edge("back", "list", "dashboard"),
    ];
    expect(
      findNavigationPath(states, transitions, "login", "form", { role: "creator" })?.map(
        (e) => e.id,
      ),
    ).toEqual(["sign in", "applications", "new"]);
    expect(findNavigationPath(states, transitions, "login", "form", { role: "viewer" })).toBeNull();
    expect(findNavigationPath(states, transitions, "login", "form", {})).toBeNull();
    expect(
      findNavigationPath(states, transitions, "form", "login", { role: "creator" }),
    ).toBeNull();
    const contextual = [
      state("start"),
      state("shared"),
      state("login", { authenticated: "true" }),
      state("profile"),
    ];
    const paths = [
      edge("direct", "start", "shared"),
      edge("login", "start", "login"),
      edge("return", "login", "shared"),
      edge("profile", "shared", "profile", { authenticated: "true" }),
    ];
    expect(
      findNavigationPath(contextual, paths, "start", "profile", { authenticated: "false" })?.map(
        (e) => e.id,
      ),
    ).toEqual(["login", "return", "profile"]);
  });

  it("chooses a shortcut, rejects unavailable edges and recognizes an existing destination", () => {
    const states = [state("settings"), state("dashboard"), state("profile")];
    const edges = [
      edge("home", "settings", "dashboard"),
      edge("profile", "dashboard", "profile"),
      edge("shortcut", "settings", "profile"),
    ];
    expect(findNavigationPath(states, edges, "settings", "profile", {})?.map((e) => e.id)).toEqual([
      "shortcut",
    ]);
    expect(
      findNavigationPath(
        states,
        edges.map((e) => ({ ...e, available: e.id !== "shortcut" })),
        "settings",
        "profile",
        {},
      )?.length,
    ).toBe(2);
    expect(findNavigationPath(states, edges, "profile", "profile", {})).toEqual([]);
    expect(findNavigationPath(states, edges, "missing", "missing", {})).toBeNull();
    const index = {
      ...state("dynamic-index"),
      name: "Dynamic Loading index",
      path: "/dynamic_loading",
      aliases: ["Dynamic Loading"],
    };
    const snapshot = { states: [index, ...states], transitions: edges, truncated: false };
    for (const [from, destination, status] of [
      [index.id, "Dynamic Loading Example 2", "no-route"],
      [index.id, "Dynamic Loading", "already-there"],
      [index.id, "Dynamic Loading index", "already-there"],
      [index.id, index.id, "already-there"],
    ] as const) {
      const result = navigationRoute(snapshot, from, destination);
      expect.soft(result.status, destination).toBe(status);
      expect.soft(result.candidates, destination).toEqual([index]);
      expect.soft(result.directUrl, destination).toBeUndefined();
      expect.soft(result.steps, destination).toEqual([]);
    }
  });

  it("does not merge states by URL or label alone and canonicalizes aliases and check ordering", () => {
    const base = state("profile");
    expect(navigationStateKey(base)).toBe(navigationStateKey({ ...base, name: "My details" }));
    expect(navigationStateKey(base)).not.toBe(
      navigationStateKey({ ...base, context: { role: "admin" } }),
    );
    expect(navigationStateKey(base)).not.toBe(
      navigationStateKey({ ...base, checks: [{ kind: "textVisible", text: "Edit" }] }),
    );
    expect(navigationStateKey(base)).toBe(navigationStateKey({ ...base, aliases: ["my info"] }));
  });
});
