import type { CSSProperties, ReactNode } from "react";
import { useEffect, useState } from "react";
import { Splitter } from "./workspace/splitter.js";

const maxWidth = 800;
const legacyWidthKey = "ardurbot:pane-width";
const legacyWideWidthKey = "ardurbot:settings-pane-width";

type PaneBounds = { min: number; initial: number; legacyKey: string | null };

function paneWidthKey(panel: string) {
  return `${legacyWidthKey}:${panel}`;
}

/**
 * The `size` prop only picks the starting width and the minimum; every panel
 * resizes and remembers its own width.
 */
function paneBounds(workspace: boolean, panel: string, size: "narrow" | "wide"): PaneBounds {
  if (workspace || panel === "computer")
    return { min: 360, initial: 480, legacyKey: legacyWidthKey };
  if (size === "wide") return { min: 384, initial: 560, legacyKey: legacyWideWidthKey };
  return { min: 384, initial: 384, legacyKey: null };
}

function clampWidth(value: number, min: number) {
  return Math.max(min, Math.min(maxWidth, Math.round(value)));
}

/**
 * Per-panel width. The older shared keys are read-only fallbacks for a panel
 * that has no width of its own yet; only the per-panel key is written.
 */
function storedPaneWidth(panel: string, bounds: PaneBounds) {
  try {
    const own = window.localStorage.getItem(paneWidthKey(panel));
    if (own !== null) {
      const saved = Number(own);
      if (Number.isFinite(saved)) return clampWidth(saved, bounds.min);
    }
    if (bounds.legacyKey) {
      const legacy = window.localStorage.getItem(bounds.legacyKey);
      const saved = Number(legacy);
      if (legacy !== null && Number.isFinite(saved)) return clampWidth(saved, bounds.min);
    }
  } catch {
    /* Storage is optional. */
  }
  return bounds.initial;
}

/** Reserve desktop space once; only the surface's transform and opacity animate. */
export function SlidingPanel({
  open,
  panel,
  children,
  workspace = false,
  expanded = false,
  size = "narrow",
  resizeLabel = "Resize pane",
}: {
  open: boolean;
  panel: string;
  children: ReactNode;
  workspace?: boolean;
  expanded?: boolean;
  /** Narrow panes start at 384 px; wide panes start roomier. Both can resize. */
  size?: "narrow" | "wide";
  resizeLabel?: string;
}) {
  const [retained, setRetained] = useState(children);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const bounds = paneBounds(workspace, panel, size);
  const current = open ? { panel, bounds } : null;
  const [lastPane, setLastPane] = useState<{ panel: string; bounds: PaneBounds } | null>(current);
  if (current && lastPane?.panel !== current.panel) setLastPane(current);
  // A closing panel keeps its width so its content does not reflow as it slides away.
  const shown = current ?? lastPane ?? { panel, bounds };
  const width = widths[shown.panel] ?? storedPaneWidth(shown.panel, shown.bounds);
  const rtl =
    typeof document !== "undefined" &&
    (document.documentElement.dir === "rtl" || document.dir === "rtl");
  if (open && retained !== children) setRetained(children);
  useEffect(() => {
    if (open) return;
    const timer = setTimeout(() => setRetained(null), 200);
    return () => clearTimeout(timer);
  }, [open]);
  const widthStyle = {
    "--pane-width": `min(${width}px, calc(100vw - 400px))`,
  } as CSSProperties;
  const changeWidth = (next: number) => {
    const clamped = clampWidth(next, bounds.min);
    setWidths((currentWidths) => ({ ...currentWidths, [panel]: clamped }));
    try {
      window.localStorage.setItem(paneWidthKey(panel), String(clamped));
    } catch {
      /* Storage is optional. */
    }
  };
  const docked = open && !expanded;
  return (
    <>
      {docked ? (
        <div
          aria-hidden="true"
          style={widthStyle}
          className="hidden shrink-0 md:block md:w-(--pane-width)"
        />
      ) : null}
      <aside
        data-testid="side-panel"
        data-panel={panel}
        aria-hidden={!open}
        inert={!open}
        style={expanded ? undefined : widthStyle}
        className={`${expanded ? "fixed inset-0 z-50 max-w-none" : "absolute inset-y-0 end-0 z-20 border-s border-sidebar-border max-w-[384px] md:max-w-none md:w-(--pane-width)"} flex w-full min-h-0 flex-col overflow-hidden bg-background transition-[transform,opacity] duration-[240ms] ease-[cubic-bezier(0.2,0.7,0.2,1)] motion-reduce:transition-none ${open ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-full opacity-0 rtl:-translate-x-full"}`}
      >
        {docked ? (
          <div className="absolute inset-y-0 start-0 z-30 hidden w-1 md:block">
            <Splitter
              label={resizeLabel}
              role="slider"
              value={width}
              min={bounds.min}
              max={maxWidth}
              step={20}
              unit="px"
              invert={!rtl}
              onChange={changeWidth}
            />
          </div>
        ) : null}
        {open ? children : retained}
      </aside>
    </>
  );
}
