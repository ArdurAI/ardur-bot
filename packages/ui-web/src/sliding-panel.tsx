import type { CSSProperties, ReactNode } from "react";
import { useEffect, useState } from "react";
import { Splitter } from "./workspace/splitter.js";

const minWidth = 360;
const maxWidth = 800;
const legacyWidthKey = "ardurbot:pane-width";

function paneWidthKey(panel: string) {
  return `${legacyWidthKey}:${panel}`;
}

function clampWidth(value: number) {
  return Math.max(minWidth, Math.min(maxWidth, Math.round(value)));
}

/** Per-panel width. The old workspace key is only a fallback for the computer pane. */
function storedPaneWidth(panel: string, workspace: boolean) {
  const fallback = workspace || panel === "computer" ? 480 : 384;
  try {
    const own = window.localStorage.getItem(paneWidthKey(panel));
    if (own !== null) {
      const saved = Number(own);
      if (Number.isFinite(saved)) return clampWidth(saved);
    }
    if (workspace || panel === "computer") {
      const legacy = window.localStorage.getItem(legacyWidthKey);
      const saved = Number(legacy);
      if (legacy !== null && Number.isFinite(saved)) return clampWidth(saved);
    }
  } catch {
    /* Storage is optional. */
  }
  return fallback;
}

/** Reserve desktop space once; only the surface's transform and opacity animate. */
export function SlidingPanel({
  open,
  panel,
  children,
  workspace = false,
  expanded = false,
  resizeLabel,
}: {
  open: boolean;
  panel: string;
  children: ReactNode;
  workspace?: boolean;
  expanded?: boolean;
  resizeLabel?: string;
}) {
  const [retained, setRetained] = useState(children);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const width = widths[panel] ?? storedPaneWidth(panel, workspace);
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
    const clamped = clampWidth(next);
    setWidths((current) => ({ ...current, [panel]: clamped }));
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
        className={`${expanded ? "fixed inset-0 z-50 max-w-none" : "absolute inset-y-0 end-0 z-20 border-s border-sidebar-border md:w-(--pane-width)"} flex w-full min-h-0 flex-col overflow-hidden bg-background transition-[transform,opacity] duration-[240ms] ease-[cubic-bezier(0.2,0.7,0.2,1)] motion-reduce:transition-none ${open ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-full opacity-0 rtl:-translate-x-full"}`}
      >
        {docked ? (
          <div className="absolute inset-y-0 start-0 z-30 hidden w-1 md:block">
            <Splitter
              label={resizeLabel ?? "Resize pane"}
              value={width}
              min={minWidth}
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
