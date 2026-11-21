import {
  ReactFlow,
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type EdgeProps,
  Position,
  Handle,
  Background,
  Panel,
  MarkerType,
  type Node,
  type NodeProps,
  type Edge,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useState } from "react";
import { useGT } from "gt-react";
import { ZoomInIcon, ZoomOutIcon, MaximizeIcon } from "lucide-react";
import { useTheme } from "../../../hooks/useTheme";
import { Button } from "../../ui/button";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../../ui/tooltip";
import { Kbd } from "../../ui/kbd";
import { cn } from "../../../lib/utils";
import type { LayoutItem, Positions } from "./navigationLayout.logic";

type ScreenNode = Node<{ item: LayoutItem; highlighted: boolean }>;
function NavigationNode({ data, selected }: NodeProps<ScreenNode>) {
  const gt = useGT();
  const { item } = data;
  return (
    <div
      className={cn(
        "flex h-14 w-52 flex-col justify-center rounded-lg border bg-card px-3 text-card-foreground shadow-sm",
        item.kind === "subgroup" && "shadow-md border-double border-4",
        selected && "ring-2 ring-ring",
        data.highlighted && "border-primary",
      )}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger render={<span className="truncate text-sm font-medium" />}>
            {item.name}
          </TooltipTrigger>
          <TooltipPopup>{item.fullPath ?? item.name}</TooltipPopup>
        </Tooltip>
        {item.warning && (
          <span
            role="img"
            aria-label={gt("Needs recheck")}
            className="size-1.5 shrink-0 rounded-full bg-warning-foreground"
          />
        )}
      </div>
      <span className="truncate text-xs text-muted-foreground">{item.description}</span>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}
function NavigationEdge(props: EdgeProps) {
  const [path, x, y] = getSmoothStepPath(props);
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        {...(props.markerEnd ? { markerEnd: props.markerEnd } : {})}
        style={props.style}
      />
      {props.label != null && (
        <EdgeLabelRenderer>
          <div
            className="pointer-events-auto absolute rounded-lg bg-popover px-1.5 py-1 text-2xs text-foreground"
            onPointerDown={(event) => event.stopPropagation()}
            style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
          >
            <Tooltip>
              <TooltipTrigger render={<span />}>{props.label}</TooltipTrigger>
              <TooltipPopup>{String(props.data?.fullLabel ?? props.label)}</TooltipPopup>
            </Tooltip>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
const edgeTypes = { navigation: NavigationEdge };
const nodeTypes = { navigation: NavigationNode };
export function NavigationCanvas(props: {
  levelId: string;
  items: readonly LayoutItem[];
  positions: Positions;
  edges: Edge[];
  selected: string | null;
  highlighted: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  canGoUp: boolean;
  onUp: () => void;
}) {
  const gt = useGT();
  const { resolvedTheme } = useTheme();
  const [flow, setFlow] = useState<ReactFlowInstance<ScreenNode> | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const nodes: ScreenNode[] = props.items.map((item) => ({
    id: item.id,
    type: "navigation",
    width: 208,
    height: 56,
    position: props.positions[item.id]!,
    data: { item, highlighted: props.highlighted.has(item.stateId ?? item.id) },
    selected: props.selected === item.id,
  }));
  return (
    <div
      tabIndex={0}
      role="group"
      aria-label={gt("Navigation canvas")}
      className="min-h-0 flex-1 -outline-offset-2"
      onKeyDown={(event) => {
        const index = props.items.findIndex((item) => item.id === props.selected);
        if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) {
          event.preventDefault();
          const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
          const next =
            props.items[
              index < 0
                ? direction > 0
                  ? 0
                  : props.items.length - 1
                : (index + direction + props.items.length) % props.items.length
            ];
          if (next) props.onSelect(next.id);
        } else if (event.key === "Enter" && props.selected) {
          event.preventDefault();
          props.onOpen(props.selected);
        } else if (event.key === "Escape" && props.canGoUp) {
          event.preventDefault();
          event.stopPropagation();
          props.onUp();
        }
      }}
    >
      <ReactFlow
        key={`${props.levelId}:${nodes.length}`}
        nodes={nodes}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        edges={props.edges.map((edge) => ({
          ...edge,
          label:
            props.edges.length > 6 &&
            ![props.selected, hovered].some((id) => id === edge.source || id === edge.target)
              ? undefined
              : edge.label,
        }))}
        onInit={setFlow}
        fitView
        fitViewOptions={{ duration: 0, padding: 0.2, maxZoom: 1 }}
        minZoom={0.001}
        maxZoom={1.5}
        colorMode={resolvedTheme}
        onNodeClick={(_event, node) =>
          node.data.item.kind === "cluster" || node.data.item.kind === "subgroup"
            ? props.onOpen(node.id)
            : props.onSelect(node.id)
        }
        onNodeMouseEnter={(_event, node) => setHovered(node.id)}
        onNodeMouseLeave={() => setHovered(null)}
        zoomOnDoubleClick={false}
        onNodeDoubleClick={(_event, node) => props.onOpen(node.id)}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesReconnectable={false}
        connectOnClick={false}
        nodesFocusable={false}
        edgesFocusable={false}
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        ariaLabelConfig={{
          "node.a11yDescription.default": gt(
            "Use arrow keys to select; Enter to open; Escape to go up.",
          ),
          "node.a11yDescription.keyboardDisabled": gt(
            "Use arrow keys to select; Enter to open; Escape to go up.",
          ),
          "edge.a11yDescription.default": gt("Connections"),
          "controls.ariaLabel": gt("Navigation canvas"),
        }}
        defaultEdgeOptions={{
          type: "navigation",
          animated: false,
          markerEnd: { type: MarkerType.ArrowClosed, color: "var(--muted-foreground)" },
          labelStyle: { fill: "var(--foreground)", fontSize: 11 },
          labelBgStyle: { fill: "var(--popover)" },
          labelBgBorderRadius: 8,
          labelBgPadding: [6, 4],
        }}
      >
        <Background color="var(--border)" gap={20} size={1} />
        <Panel position="bottom-left">
          <div className="flex gap-1 rounded-lg border bg-popover p-1 shadow-sm">
            {[
              {
                label: gt("Zoom in"),
                icon: ZoomInIcon,
                run: () => void flow?.zoomIn({ duration: 0 }),
              },
              {
                label: gt("Zoom out"),
                icon: ZoomOutIcon,
                run: () => void flow?.zoomOut({ duration: 0 }),
              },
              {
                label: gt("Fit view"),
                icon: MaximizeIcon,
                run: () => void flow?.fitView({ duration: 0, maxZoom: 1, padding: 0.2 }),
              },
            ].map(({ label, icon: Icon, run }) => (
              <Tooltip key={label}>
                <TooltipTrigger
                  render={
                    <Button size="icon-sm" variant="ghost" aria-label={label} onClick={run} />
                  }
                >
                  <Icon />
                </TooltipTrigger>
                <TooltipPopup>{label}</TooltipPopup>
              </Tooltip>
            ))}
          </div>
        </Panel>
        <Panel position="bottom-right">
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Kbd>↑↓←→</Kbd>
            <Kbd>Enter</Kbd>
            <Kbd>Esc</Kbd>
          </div>
        </Panel>
      </ReactFlow>
    </div>
  );
}
