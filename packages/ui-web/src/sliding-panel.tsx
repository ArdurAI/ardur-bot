import type { CSSProperties, ReactNode } from "react";
import { useEffect, useState } from "react";

const workspaceWidthKey = "ardurbot:pane-width";
function initialWorkspaceWidth() {
  try {
    const saved = Number(window.localStorage.getItem(workspaceWidthKey));
    return Number.isFinite(saved) && saved >= 360 && saved <= 800 ? saved : 480;
  } catch {
    return 480;
  }
}

/** Reserve desktop space once; only the surface's transform and opacity animate. */
export function SlidingPanel({
  open,
  panel,
  children,
  workspace = false,
  expanded = false,
}: {
  open: boolean;
  panel: string;
  children: ReactNode;
  workspace?: boolean;
  expanded?: boolean;
}) {
  const [retained, setRetained] = useState(children);
  const [workspaceWidth, setWorkspaceWidth] = useState(initialWorkspaceWidth);
  useEffect(() => {
    if (!workspace) return;
    try {
      window.localStorage.setItem(workspaceWidthKey, String(workspaceWidth));
    } catch {
      /* optional */
    }
  }, [workspace, workspaceWidth]);
  if (open && retained !== children) setRetained(children);
  useEffect(() => {
    if (open) return;
    const timer = setTimeout(() => setRetained(null), 200);
    return () => clearTimeout(timer);
  }, [open]);
  const widthStyle = workspace
    ? ({
        "--workspace-pane-width": `min(${workspaceWidth}px, calc(100vw - 400px))`,
      } as CSSProperties)
    : undefined;
  return (
    <>
      {open && !expanded ? (
        <div
          aria-hidden="true"
          style={widthStyle}
          className={`hidden shrink-0 md:block ${workspace ? "md:w-(--workspace-pane-width)" : "md:w-[384px]"}`}
        />
      ) : null}
      <aside
        data-testid="side-panel"
        data-panel={panel}
        aria-hidden={!open}
        inert={!open}
        style={widthStyle}
        className={`${expanded ? "fixed inset-0 z-50 max-w-none" : "absolute inset-y-0 end-0 z-20 max-w-full border-s border-sidebar-border"} flex w-full min-h-0 flex-col overflow-hidden bg-background transition-[transform,opacity] duration-[240ms] ease-[cubic-bezier(0.2,0.7,0.2,1)] motion-reduce:transition-none ${!expanded && workspace ? "md:w-(--workspace-pane-width)" : !expanded ? "max-w-[384px]" : ""} ${open ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-full opacity-0 rtl:-translate-x-full"}`}
      >
        {workspace && open && !expanded ? (
          <hr
            aria-orientation="vertical"
            aria-label="Resize pane"
            aria-valuenow={workspaceWidth}
            aria-valuemin={360}
            aria-valuemax={800}
            tabIndex={0}
            className="absolute inset-y-0 start-0 z-30 hidden w-1 cursor-col-resize hover:bg-border focus-visible:bg-ring md:block"
            onKeyDown={(event) => {
              const delta = event.key === "ArrowLeft" ? 20 : event.key === "ArrowRight" ? -20 : 0;
              if (!delta) return;
              event.preventDefault();
              setWorkspaceWidth((width) => Math.max(360, Math.min(800, width + delta)));
            }}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              const startX = event.clientX;
              const startWidth = workspaceWidth;
              const handle = event.currentTarget;
              handle.onpointermove = (move) => {
                if (!handle.hasPointerCapture(move.pointerId)) return;
                const direction = document.dir === "rtl" ? -1 : 1;
                setWorkspaceWidth(
                  Math.max(360, Math.min(800, startWidth + (startX - move.clientX) * direction)),
                );
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
