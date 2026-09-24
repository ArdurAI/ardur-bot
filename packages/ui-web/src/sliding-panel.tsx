import type { ReactNode } from "react";
import { useEffect, useState } from "react";

/** Reserve desktop space once; only the surface's transform and opacity animate. */
export function SlidingPanel({
  open,
  panel,
  children,
}: {
  open: boolean;
  panel: string;
  children: ReactNode;
}) {
  const [retained, setRetained] = useState(children);
  if (open && retained !== children) setRetained(children);
  useEffect(() => {
    if (open) return;
    const timer = setTimeout(() => setRetained(null), 200);
    return () => clearTimeout(timer);
  }, [open]);
  return (
    <>
      {open ? <div aria-hidden="true" className="hidden shrink-0 md:block md:w-[384px]" /> : null}
      <aside
        data-testid="side-panel"
        data-panel={panel}
        aria-hidden={!open}
        inert={!open}
        className={`absolute inset-y-0 end-0 z-20 flex w-full max-w-[384px] min-h-0 flex-col overflow-hidden border-s border-sidebar-border bg-background transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none ${open ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-full opacity-0 rtl:-translate-x-full"}`}
      >
        {open ? children : retained}
      </aside>
    </>
  );
}
