import type { CSSProperties, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { clampWorkspacePanelSize, workspacePanelLayout } from "./workspace/panel-layout.js";
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
  width: controlledWidth,
  height = 280,
  position = "right",
  onWidthChange,
  onHeightChange,
  onOverlayChange,
  keepMounted = false,
}: {
  open: boolean;
  panel: string;
  children: ReactNode;
  workspace?: boolean;
  expanded?: boolean;
  /** Narrow panes start at 384 px; wide panes start roomier. Both can resize. */
  size?: "narrow" | "wide";
  resizeLabel?: string;
  width?: number;
  height?: number;
  position?: "right" | "left" | "bottom";
  onWidthChange?(width: number): void;
  onHeightChange?(height: number): void;
  onOverlayChange?(overlay: boolean): void;
  keepMounted?: boolean;
}) {
  const aside = useRef<HTMLElement>(null);
  const [extent, setExtent] = useState<{ width: number; height: number } | undefined>();
  const [narrow, setNarrow] = useState(
    () =>
      typeof window !== "undefined" && window.matchMedia?.("(max-width: 767px)").matches === true,
  );
  useEffect(() => {
    if (!workspace || controlledWidth === undefined) return;
    const media = window.matchMedia?.("(max-width: 767px)");
    const refreshMedia = () => setNarrow(media?.matches === true);
    media?.addEventListener("change", refreshMedia);
    const parent = aside.current?.parentElement;
    const observer =
      typeof ResizeObserver !== "undefined" && parent
        ? new ResizeObserver(([entry]) => {
            if (entry && entry.contentRect.width > 0)
              setExtent({ width: entry.contentRect.width, height: entry.contentRect.height });
          })
        : null;
    if (parent) observer?.observe(parent);
    return () => {
      observer?.disconnect();
      media?.removeEventListener("change", refreshMedia);
    };
  }, [workspace, controlledWidth !== undefined]);
  const [retained, setRetained] = useState(children);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const bounds = paneBounds(workspace, panel, size);
  const current = open ? { panel, bounds } : null;
  const [lastPane, setLastPane] = useState<{ panel: string; bounds: PaneBounds } | null>(current);
  if (current && lastPane?.panel !== current.panel) setLastPane(current);
  // A closing panel keeps its width so its content does not reflow as it slides away.
  const shown = current ?? lastPane ?? { panel, bounds };
  const savedWidth =
    controlledWidth ?? widths[shown.panel] ?? storedPaneWidth(shown.panel, shown.bounds);
  const layout = workspacePanelLayout({
    open,
    expanded,
    narrow,
    available: extent?.width,
    position,
  });
  const controlled = workspace && controlledWidth !== undefined;
  const overlay = controlled ? layout.overlay : expanded;
  const stacked = controlled && layout.stacked && !overlay;
  const width = controlled
    ? clampWorkspacePanelSize({ size: savedWidth, available: extent?.width, stacked: false })
    : savedWidth;
  const panelHeight = clampWorkspacePanelSize({
    size: height,
    available: extent?.height,
    stacked: true,
  });
  const limit = controlled
    ? clampWorkspacePanelSize({
        size: stacked ? 600 : 800,
        available: stacked ? extent?.height : extent?.width,
        stacked,
      })
    : maxWidth;
  useEffect(() => {
    onOverlayChange?.(overlay);
  }, [overlay, onOverlayChange]);
  const rtl =
    typeof document !== "undefined" &&
    (document.documentElement.dir === "rtl" || document.dir === "rtl");
  if (open && retained !== children) setRetained(children);
  useEffect(() => {
    if (open || keepMounted) return;
    const timer = setTimeout(() => setRetained(null), 200);
    return () => clearTimeout(timer);
  }, [open, keepMounted]);
  const widthStyle = {
    "--pane-width": `min(${width}px, calc(100vw - 400px))`,
    ...(stacked ? { "--pane-height": `${panelHeight}px` } : {}),
  } as CSSProperties;
  const changeWidth = (next: number) => {
    if (controlled) {
      const clamped = clampWorkspacePanelSize({
        size: next,
        available: stacked ? extent?.height : extent?.width,
        stacked,
      });
      if (stacked) onHeightChange?.(clamped);
      else onWidthChange?.(clamped);
      return;
    }
    const clamped = clampWidth(next, bounds.min);
    setWidths((currentWidths) => ({ ...currentWidths, [panel]: clamped }));
    try {
      window.localStorage.setItem(paneWidthKey(panel), String(clamped));
    } catch {
      /* Storage is optional. */
    }
  };
  const docked = open && !overlay;
  return (
    <>
      {docked ? (
        <div
          aria-hidden="true"
          style={widthStyle}
          className={
            stacked
              ? "shrink-0 h-(--pane-height)"
              : `hidden shrink-0 md:block md:w-(--pane-width) ${position === "left" ? "order-first" : ""}`
          }
        />
      ) : null}
      <aside
        ref={aside}
        data-testid="side-panel"
        data-panel={panel}
        aria-hidden={!open}
        inert={!open}
        data-overlay={overlay ? "true" : "false"}
        data-position={position}
        style={overlay ? undefined : widthStyle}
        className={`${overlay ? `${expanded ? "fixed" : "absolute"} inset-0 z-50 max-w-none` : stacked ? "absolute inset-x-0 bottom-0 z-20 border-t border-border h-(--pane-height)" : `absolute inset-y-0 ${position === "left" ? "start-0 border-e" : "end-0 border-s"} z-20 border-sidebar-border max-w-[384px] md:max-w-none md:w-(--pane-width)`} flex w-full min-h-0 flex-col overflow-hidden bg-background transition-[transform,opacity] duration-[240ms] ease-[cubic-bezier(0.2,0.7,0.2,1)] motion-reduce:transition-none ${open ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-full opacity-0 rtl:-translate-x-full"}`}
      >
        {docked ? (
          <div
            className={
              stacked
                ? "absolute inset-x-0 top-0 z-30 h-1"
                : `absolute inset-y-0 ${position === "left" ? "end-0" : "start-0"} z-30 hidden w-1 md:block`
            }
          >
            <Splitter
              label={resizeLabel}
              role="slider"
              horizontal={stacked}
              value={stacked ? panelHeight : width}
              min={stacked ? 200 : bounds.min}
              max={limit}
              step={20}
              unit="px"
              invert={stacked ? false : position === "left" ? rtl : !rtl}
              onChange={changeWidth}
            />
          </div>
        ) : null}
        {open || keepMounted ? children : retained}
      </aside>
    </>
  );
}
