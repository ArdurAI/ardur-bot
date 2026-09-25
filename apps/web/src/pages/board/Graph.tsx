import type { BoardGraph } from "@ardurbot/contracts/board";
import { useLingui } from "@lingui/react/macro";
import { useId } from "react";

export function graphPositions(graph: BoardGraph) {
  const levels = new Map(graph.items.map((item) => [item.id, 0]));
  for (let pass = 0; pass < graph.items.length; pass++) {
    let changed = false;
    for (const edge of graph.edges) {
      if (edge.type !== "blocks" || !levels.has(edge.from) || !levels.has(edge.to)) continue;
      const level = Math.min(graph.items.length, (levels.get(edge.to) ?? 0) + 1);
      if (level > (levels.get(edge.from) ?? 0)) {
        levels.set(edge.from, level);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const rows = new Map<number, number>();
  return new Map(
    graph.items.map((item) => {
      const level = levels.get(item.id) ?? 0;
      const row = rows.get(level) ?? 0;
      rows.set(level, row + 1);
      return [item.id, { x: 24 + level * 260, y: 24 + row * 88 }];
    }),
  );
}
export function DependencyGraph({
  graph,
  onOpen,
}: {
  graph: BoardGraph;
  onOpen: (id: string) => void;
}) {
  const { t } = useLingui();
  const marker = useId();
  const positions = graphPositions(graph);
  const width = Math.max(300, ...[...positions.values()].map((p) => p.x + 240));
  const height = Math.max(160, ...[...positions.values()].map((p) => p.y + 80));
  return (
    <div className="overflow-auto">
      <svg width={width} height={height} role="img" aria-label={t`Dependencies`}>
        <title>{t`Dependencies`}</title>
        <defs>
          <marker id={marker} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8" className="fill-muted-foreground" />
          </marker>
        </defs>
        {graph.edges.map((edge) => {
          const from = positions.get(edge.to);
          const to = positions.get(edge.from);
          return from && to ? (
            <path
              key={`${edge.from}:${edge.to}:${edge.type}`}
              d={`M${from.x + 216},${from.y + 28} C${from.x + 240},${from.y + 28} ${to.x - 24},${to.y + 28} ${to.x},${to.y + 28}`}
              fill="none"
              className="stroke-muted-foreground"
              strokeDasharray={edge.type === "blocks" ? undefined : "4 4"}
              markerEnd={`url(#${marker})`}
            >
              <title>{edge.type}</title>
            </path>
          ) : null;
        })}
        {graph.items.map((item) => {
          const point = positions.get(item.id)!;
          return (
            // biome-ignore lint/a11y/useSemanticElements: SVG has no native button; this node has a name and keyboard handling.
            <g
              key={item.id}
              role="button"
              tabIndex={0}
              aria-label={item.title}
              onClick={() => onOpen(item.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpen(item.id);
                }
              }}
              className="cursor-pointer outline-none focus:stroke-primary"
            >
              <rect
                x={point.x}
                y={point.y}
                width="216"
                height="56"
                rx="8"
                className="fill-card stroke-border"
              />
              <text x={point.x + 12} y={point.y + 22} className="fill-foreground text-sm">
                {item.title.length > 27 ? `${item.title.slice(0, 26)}…` : item.title}
              </text>
              <text x={point.x + 12} y={point.y + 42} className="fill-muted-foreground text-xs">
                {item.id} · P{item.priority}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
