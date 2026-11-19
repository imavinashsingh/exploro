import type { EnvironmentId, QaRun, QaSuiteSummary } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { T, Var, useGT } from "gt-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { buildSiteMap, type SiteMapNode, type SiteMapStatus } from "./projectSiteMap.logic";

const NODE_WIDTH = 136;
const NODE_HEIGHT = 44;
const COLUMN_GAP = 44;
const ROW_GAP = 14;
const PADDING = 8;

const nodeX = (node: Pick<SiteMapNode, "column">) =>
  PADDING + node.column * (NODE_WIDTH + COLUMN_GAP);
const nodeY = (node: Pick<SiteMapNode, "row">) => PADDING + node.row * (NODE_HEIGHT + ROW_GAP);

const NODE_CLASS: Record<SiteMapStatus, string> = {
  pass: "fill-success/8 stroke-success",
  fail: "fill-destructive/8 stroke-destructive",
  unclear: "fill-warning/8 stroke-warning",
};
const EDGE_CLASS: Record<SiteMapStatus, string> = {
  pass: "stroke-success/60",
  fail: "stroke-destructive/70",
  unclear: "stroke-warning/70",
};

function Legend() {
  const swatch = "inline-block size-2.5 rounded-full";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span className={cn(swatch, "bg-success")} aria-hidden />
        <T>Passed</T>
      </span>
      <span className="flex items-center gap-1.5">
        <span className={cn(swatch, "bg-destructive")} aria-hidden />
        <T>Failed</T>
      </span>
      <span className="flex items-center gap-1.5">
        <span className={cn(swatch, "bg-warning")} aria-hidden />
        <T>Unclear</T>
      </span>
      <span className="flex items-center gap-1.5">
        <span className={cn(swatch, "border border-dashed border-muted-foreground")} aria-hidden />
        <T>No suite</T>
      </span>
    </div>
  );
}

/** Pages the project's tests reached, joined by the paths they took, colored by last verdict. */
export function ProjectSiteMap(props: {
  readonly environmentId: EnvironmentId;
  readonly runs: ReadonlyArray<QaRun>;
  readonly suites: ReadonlyArray<QaSuiteSummary>;
  readonly onRunSuite: (suite: QaSuiteSummary) => void;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const map = buildSiteMap(props.runs);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  if (map.nodes.length === 0)
    return (
      <p className="m-0 px-3 py-6 text-center text-xs text-muted-foreground">
        <T>The map fills in as tests visit pages. Run a test or a suite to start it.</T>
      </p>
    );

  const byKey = new Map(map.nodes.map((node) => [node.key, node]));
  const selected = (selectedKey === null ? null : byKey.get(selectedKey)) ?? null;
  const width =
    PADDING * 2 +
    (Math.max(...map.nodes.map((node) => node.column)) + 1) * (NODE_WIDTH + COLUMN_GAP) -
    COLUMN_GAP;
  const height =
    PADDING * 2 +
    (Math.max(...map.nodes.map((node) => node.row)) + 1) * (NODE_HEIGHT + ROW_GAP) -
    ROW_GAP;
  const hosts = new Set(map.nodes.map((node) => node.host));
  const selectedSuite =
    selected?.last.suiteId == null
      ? null
      : (props.suites.find((suite) => suite.suiteId === selected.last.suiteId) ?? null);

  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Legend />
        <span className="text-xs text-muted-foreground">
          {gt("{pages} pages · {covered} covered", {
            pages: map.nodes.length,
            covered: map.coveredCount,
          })}
        </span>
      </div>
      <div className="overflow-x-auto rounded-md border border-border/65 bg-muted/20">
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="group"
          aria-label={gt("Site map")}
          className="block"
        >
          <defs>
            <marker
              id="project-site-map-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto"
            >
              <path d="M0 0L10 5L0 10z" className="fill-muted-foreground/70" />
            </marker>
          </defs>
          {map.edges.map((edge) => {
            const from = byKey.get(edge.from)!;
            const to = byKey.get(edge.to)!;
            const x1 = nodeX(from) + NODE_WIDTH;
            const y1 = nodeY(from) + NODE_HEIGHT / 2;
            const x2 = nodeX(to);
            const y2 = nodeY(to) + NODE_HEIGHT / 2;
            const back = to.column <= from.column;
            const bend = Math.max(24, Math.abs(x2 - x1) / 2);
            const d = back
              ? `M${nodeX(from) + NODE_WIDTH / 2} ${nodeY(from) + NODE_HEIGHT} C${nodeX(from) + NODE_WIDTH / 2} ${y1 + NODE_HEIGHT}, ${nodeX(to) + NODE_WIDTH / 2} ${y2 + NODE_HEIGHT}, ${nodeX(to) + NODE_WIDTH / 2} ${nodeY(to) + NODE_HEIGHT}`
              : `M${x1} ${y1} C${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2 - 2} ${y2}`;
            return (
              <path
                key={`${edge.from}\n${edge.to}`}
                d={d}
                fill="none"
                strokeWidth={1.5}
                strokeDasharray={to.covered ? undefined : "4 4"}
                markerEnd="url(#project-site-map-arrow)"
                className={EDGE_CLASS[to.status]}
              />
            );
          })}
          {map.nodes.map((node) => {
            const x = nodeX(node);
            const y = nodeY(node);
            const isSelected = node.key === selectedKey;
            const label = hosts.size > 1 ? `${node.host}${node.path}` : node.path;
            return (
              <g
                key={node.key}
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                aria-label={gt("{page}, {status}", {
                  page: label,
                  status:
                    node.status === "pass"
                      ? gt("passed")
                      : node.status === "fail"
                        ? gt("failed")
                        : gt("unclear"),
                })}
                className="cursor-pointer outline-none focus-visible:[&>rect]:stroke-ring"
                onClick={() => setSelectedKey(isSelected ? null : node.key)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  setSelectedKey(isSelected ? null : node.key);
                }}
              >
                <rect
                  x={x}
                  y={y}
                  width={NODE_WIDTH}
                  height={NODE_HEIGHT}
                  rx={8}
                  strokeWidth={isSelected ? 2 : 1}
                  strokeDasharray={node.covered ? undefined : "4 3"}
                  className={NODE_CLASS[node.status]}
                />
                <text x={x + 10} y={y + 18} className="fill-foreground text-xs font-medium">
                  <title>{label}</title>
                  {label.length > 18 ? `…${label.slice(-17)}` : label}
                </text>
                <text x={x + 10} y={y + 33} className="fill-muted-foreground text-2xs">
                  {node.title !== null && node.title.length > 0
                    ? node.title.length > 20
                      ? `${node.title.slice(0, 19)}…`
                      : node.title
                    : node.covered
                      ? gt("Guarded by a suite")
                      : gt("No suite yet")}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      {selected === null ? (
        <p className="m-0 text-xs text-muted-foreground">
          <T>Select a page to see the test that last reached it.</T>
        </p>
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-md bg-muted/40 px-2.5 py-2 text-xs">
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{selected.path}</span>
            <span className="block truncate text-muted-foreground">
              <T>
                Last reached by <Var>{selected.last.scenario}</Var>
              </T>
            </span>
          </span>
          <Button
            size="compact"
            variant="outline"
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId: props.environmentId, threadId: selected.last.threadId },
              })
            }
          >
            <T>Open run</T>
          </Button>
          {selectedSuite === null ? null : (
            <Button
              size="compact"
              variant="outline"
              onClick={() => props.onRunSuite(selectedSuite)}
            >
              <T>Run suite</T>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
