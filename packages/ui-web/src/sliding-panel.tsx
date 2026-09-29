import type { CSSProperties, ReactNode } from "react";
import { useEffect, useState } from "react";

/** Each resizable pane remembers its own width. */
const paneWidths = {
  workspace: { key: "ardurbot:pane-width", min: 360, initial: 480 },
  wide: { key: "ardurbot:settings-pane-width", min: 384, initial: 560 },
} as const;
type ResizablePane = keyof typeof paneWidths;
const maxPaneWidth = 800;

function savedPaneWidth(pane: ResizablePane) {
  const { key, min, initial } = paneWidths[pane];
  try {
    const saved = Number(window.localStorage.getItem(key));
    return Number.isFinite(saved) && saved >= min && saved <= maxPaneWidth ? saved : initial;
  } catch {
    return initial;
  }
}

/** Reserve desktop space once; only the surface's transform and opacity animate. */
export function SlidingPanel({
  open,
  panel,
  children,
  workspace = false,
  expanded = false,
  size = "narrow",
}: {
  open: boolean;
  panel: string;
  children: ReactNode;
  workspace?: boolean;
  expanded?: boolean;
  /** Narrow forms stay at 384 px; wide panes start roomier and can be dragged wider. */
  size?: "narrow" | "wide";
}) {
  const [retained, setRetained] = useState(children);
  const [widths, setWidths] = useState(() => ({
    workspace: savedPaneWidth("workspace"),
    wide: savedPaneWidth("wide"),
  }));
  const resizable: ResizablePane | null = workspace ? "workspace" : size === "wide" ? "wide" : null;
  const width = resizable ? widths[resizable] : null;
  useEffect(() => {
    if (!resizable || width === null) return;
    try {
      window.localStorage.setItem(paneWidths[resizable].key, String(width));
    } catch {
      /* optional */
    }
  }, [resizable, width]);
  if (open && retained !== children) setRetained(children);
  useEffect(() => {
    if (open) return;
    const timer = setTimeout(() => setRetained(null), 200);
    return () => clearTimeout(timer);
  }, [open]);
  const resize = (pane: ResizablePane, next: (width: number) => number) =>
    setWidths((current) => ({
      ...current,
      [pane]: Math.max(paneWidths[pane].min, Math.min(maxPaneWidth, next(current[pane]))),
    }));
  const widthStyle =
    width === null
      ? undefined
      : ({ "--pane-width": `min(${width}px, calc(100vw - 400px))` } as CSSProperties);
  return (
    <>
      {open && !expanded ? (
        <div
          aria-hidden="true"
          style={widthStyle}
          className={`hidden shrink-0 md:block ${resizable ? "md:w-(--pane-width)" : "md:w-[384px]"}`}
        />
      ) : null}
      <aside
        data-testid="side-panel"
        data-panel={panel}
        aria-hidden={!open}
        inert={!open}
        style={widthStyle}
        className={`${expanded ? "fixed inset-0 z-50 max-w-none" : "absolute inset-y-0 end-0 z-20 border-s border-sidebar-border"} flex w-full min-h-0 flex-col overflow-hidden bg-background transition-[transform,opacity] duration-[240ms] ease-[cubic-bezier(0.2,0.7,0.2,1)] motion-reduce:transition-none ${!expanded && resizable ? "md:w-(--pane-width)" : !expanded ? "max-w-[384px]" : ""} ${open ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-full opacity-0 rtl:-translate-x-full"}`}
      >
        {resizable && open && !expanded ? (
          <hr
            aria-orientation="vertical"
            aria-label="Resize pane"
            aria-valuenow={widths[resizable]}
            aria-valuemin={paneWidths[resizable].min}
            aria-valuemax={maxPaneWidth}
            tabIndex={0}
            className="absolute inset-y-0 start-0 z-30 hidden w-1 cursor-col-resize hover:bg-border focus-visible:bg-ring md:block"
            onKeyDown={(event) => {
              const delta = event.key === "ArrowLeft" ? 20 : event.key === "ArrowRight" ? -20 : 0;
              if (!delta) return;
              event.preventDefault();
              resize(resizable, (current) => current + delta);
            }}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              const startX = event.clientX;
              const startWidth = widths[resizable];
              const handle = event.currentTarget;
              handle.onpointermove = (move) => {
                if (!handle.hasPointerCapture(move.pointerId)) return;
                const direction = document.dir === "rtl" ? -1 : 1;
                resize(resizable, () => startWidth + (startX - move.clientX) * direction);
              };
              handle.onpointerup = () => {
                handle.onpointermove = null;
                handle.onpointerup = null;
              };
            }}
          />
        ) : null}
        {open ? children : retained}
      </aside>
    </>
  );
}
