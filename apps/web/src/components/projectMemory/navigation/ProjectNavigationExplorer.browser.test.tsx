import "~/index.css";

import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../../test/render";
import { ProjectNavigationDialog } from "./ProjectNavigationDialog";

const mocks = vi.hoisted(() => ({ queries: new Map<string, unknown>() }));
vi.mock("../../../state/server", () => {
  const query = (name: string) => () => mocks.queries.get(name);
  return {
    serverEnvironment: {
      projectMemorySnapshot: query("overview"),
      navigationOverview: query("overview"),
      navigationChildren: query("children"),
      navigationNeighborhood: query("neighborhood"),
      navigationSearch: query("search"),
      navigationRoutePreview: query("route"),
      navigationDetails: query("details"),
      deleteNavigationRecord: { permissionAtom: () => mocks.queries.get("permission") },
    },
  };
});
vi.mock("../../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("../../../state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success" }),
}));

function setup(pendingRoute = false) {
  mocks.queries.clear();
  const state = (id: string, name: string) => ({
    id,
    name,
    environment: "https://example.test",
    path: "/app",
    incomingCount: 0,
    outgoingCount: 0,
  });
  const alpha = state("alpha", "Alpha");
  const beta = state("beta", "Beta");
  const transition = {
    id: "alpha-beta",
    from: alpha.id,
    to: beta.id,
    action: "Open Beta",
    conditions: {},
    runId: "run-1",
    threadId: "thread-1",
    observedAt: "2026-11-21T00:00:00Z",
    available: true,
  };
  const childrenData = {
    kind: "states" as const,
    connections: [transition],
    connectionsTruncated: false,
    states: [alpha, beta],
    nextCursor: null,
    truncated: false,
    limit: 100,
  };
  const children = Atom.make(AsyncResult.success(childrenData));
  mocks.queries.set(
    "overview",
    Atom.make(
      AsyncResult.success({
        clusters: [
          {
            environment: alpha.environment,
            pathGroup: "/app",
            stateCount: 2,
            incomingCount: 0,
            outgoingCount: 0,
          },
        ],
        connections: [],
        limit: 100,
        truncated: false,
      }),
    ),
  );
  mocks.queries.set("children", children);
  mocks.queries.set(
    "neighborhood",
    Atom.make(
      AsyncResult.success({
        state: alpha,
        incoming: [],
        outgoing: [],
        incomingTruncated: false,
        outgoingTruncated: false,
        truncated: false,
        limit: 100,
      }),
    ),
  );
  mocks.queries.set(
    "details",
    Atom.make(
      AsyncResult.success({
        state: {
          ...alpha,
          aliases: ["Home"],
          context: { role: "administrator" },
          checks: [
            { kind: "textVisible", text: "Alpha" },
            { kind: "urlIncludes", value: "/app" },
          ],
        },
        incomingCount: 0,
        outgoingCount: 1,
        needsRecheckCount: 0,
        runs: [],
        truncated: false,
        limit: 100,
      }),
    ),
  );
  mocks.queries.set(
    "search",
    Atom.make(
      AsyncResult.success({ states: [alpha, beta], nextCursor: null, truncated: false, limit: 50 }),
    ),
  );
  const routeData = {
    status: "found" as const,
    steps: [{ transition, destination: beta }],
    limit: 100,
    truncated: false,
  };
  const route = Atom.make(
    AsyncResult.success(pendingRoute ? { ...routeData, steps: [] } : routeData),
  );
  mocks.queries.set("route", route);
  mocks.queries.set("permission", Atom.make(true));
  return { children, childrenData, route, routeData, registry: AtomRegistry.make() };
}

describe("navigation explorer", () => {
  it("navigates with keys, retains selection and camera on refetch, and exposes zoom and fit", async () => {
    const { children, childrenData, registry } = setup();
    await page.viewport(1280, 900);
    await using _screen = await render(
      <RegistryContext value={registry}>
        <ProjectNavigationDialog
          environmentId={EnvironmentId.make("test")}
          projectId={ProjectId.make("project")}
        />
      </RegistryContext>,
    );
    await page.getByRole("button", { name: "Open explorer", exact: true }).click();
    await page.getByRole("button", { name: "Graph", exact: true }).click();
    const canvas = page.getByRole("group", { name: "Navigation canvas" });
    await page.getByRole("button", { name: "Fit view", exact: true }).click();
    await act(() => canvas.element().focus());
    await expect.element(canvas).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}{Enter}");
    await expect
      .element(
        page
          .getByRole("navigation", { name: "Navigation breadcrumbs" })
          .getByText("/app", { exact: true }),
      )
      .toBeVisible();
    await act(() => canvas.element().focus());
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(page.getByLabelText("State details")).toBeVisible();
    await page.getByRole("button", { name: "Delete from memory", exact: true }).click();
    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
    await expect
      .element(
        page
          .getByRole("navigation", { name: "Navigation breadcrumbs" })
          .getByText("/app", { exact: true }),
      )
      .toBeVisible();
    const viewport = () => document.querySelector<HTMLElement>(".react-flow__viewport")!;
    const originalTransform = viewport().style.transform;
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    await vi.waitFor(() => expect(viewport().style.transform).not.toBe(originalTransform));
    const zoomed = viewport().style.transform;
    await act(() =>
      registry.set(
        children,
        AsyncResult.success({ ...childrenData, states: [...childrenData.states] }),
      ),
    );
    await expect.element(page.getByLabelText("State details")).toBeVisible();
    expect(document.querySelector(".react-flow__node.selected")?.getAttribute("data-id")).toBe(
      "alpha",
    );
    expect(viewport().style.transform).toBe(zoomed);
    await page.getByRole("button", { name: "Zoom out", exact: true }).click();
    await vi.waitFor(() => expect(viewport().style.transform).not.toBe(zoomed));
    await page.getByRole("button", { name: "Fit view", exact: true }).click();
    const fitted = viewport().style.transform;
    await act(() => canvas.element().focus());
    await page.getByText("Alpha", { exact: true }).first().dblClick();
    await expect
      .element(
        page
          .getByRole("navigation", { name: "Navigation breadcrumbs" })
          .getByText("› Alpha", { exact: true }),
      )
      .toBeVisible();
    await expect.element(canvas).toHaveFocus();
    await expect.element(page.getByText("Alpha", { exact: true }).first()).toBeVisible();
    await act(() => canvas.element().focus());
    await userEvent.keyboard("{Escape}");
    await expect
      .element(
        page
          .getByRole("navigation", { name: "Navigation breadcrumbs" })
          .getByText("/app", { exact: true }),
      )
      .toBeVisible();
    await vi.waitFor(() => expect(viewport().style.transform).toBe(fitted));
    await expect.element(canvas).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect
      .element(
        page
          .getByRole("navigation", { name: "Navigation breadcrumbs" })
          .getByText("/app", { exact: true }),
      )
      .not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await expect
      .element(
        page
          .getByRole("navigation", { name: "Navigation breadcrumbs" })
          .getByText("example.test", { exact: true }),
      )
      .not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  });
  it("keeps the canvas visible while keyboard search selects a dropdown result", async () => {
    const { registry, route, routeData } = setup(true);
    await page.viewport(414, 900);
    await using _screen = await render(
      <RegistryContext value={registry}>
        <ProjectNavigationDialog
          environmentId={EnvironmentId.make("test")}
          projectId={ProjectId.make("project")}
        />
      </RegistryContext>,
    );
    await page.getByRole("button", { name: "Open explorer", exact: true }).click();
    await page.getByRole("button", { name: "Graph", exact: true }).click();
    await page.getByRole("combobox", { name: "Search navigation" }).fill("Alpha");
    await expect.element(page.getByRole("option", { name: /Alpha/ })).toBeVisible();
    await expect.element(page.getByRole("group", { name: "Navigation canvas" })).toBeVisible();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await expect.element(page.getByLabelText("State details")).toBeVisible();
    await expect.element(page.getByRole("listbox")).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Route from here", exact: true }).click();
    await page.getByRole("combobox", { name: "Search navigation" }).fill("Beta");
    await page.getByRole("option", { name: /Beta/ }).click();
    await expect
      .element(page.getByText("Route: Alpha → Beta · 0 steps", { exact: true }))
      .toBeVisible();
    await act(() => registry.set(route, AsyncResult.success(routeData)));
    await vi.waitFor(() => {
      const canvas = page
        .getByRole("group", { name: "Navigation canvas" })
        .element()
        .getBoundingClientRect();
      const last = document
        .querySelector<HTMLElement>('.react-flow__node[data-id="step:1"]')!
        .getBoundingClientRect();
      expect(last.left).toBeGreaterThanOrEqual(canvas.left);
      expect(last.right).toBeLessThanOrEqual(canvas.right);
    });
    await expect
      .element(page.getByText("Route: Alpha → Beta · 1 step", { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByText("Route from Alpha: choose a destination", { exact: true }))
      .not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Back", exact: true })).toBeVisible();
  });
});
