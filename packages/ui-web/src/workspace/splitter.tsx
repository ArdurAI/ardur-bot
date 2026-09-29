import { useRef } from "react";

export function Splitter({
  label,
  horizontal = false,
  value,
  onChange,
  min = 15,
  max,
  step = 2,
  invert = false,
  unit = "percent",
}: {
  label: string;
  horizontal?: boolean;
  value: number;
  onChange(value: number): void;
  min?: number;
  max?: number;
  step?: number;
  invert?: boolean;
  unit?: "percent" | "px";
}) {
  const limit = max ?? (horizontal ? 65 : 40);
  const drag = useRef<{ at: number; value: number; extent: number } | null>(null);
  const negative = horizontal ? "ArrowDown" : "ArrowLeft";
  const positive = horizontal ? "ArrowUp" : "ArrowRight";
  return (
    <hr
      tabIndex={0}
      aria-label={label}
      aria-orientation={horizontal ? "horizontal" : "vertical"}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={limit}
      className={
        horizontal
          ? "m-0 h-1 border-0 shrink-0 cursor-row-resize touch-none bg-border hover:bg-primary focus-visible:bg-primary"
          : "m-0 h-full w-1 border-0 shrink-0 cursor-col-resize touch-none bg-border hover:bg-primary focus-visible:bg-primary"
      }
      onPointerDown={(event) => {
        const box = event.currentTarget.parentElement?.getBoundingClientRect();
        drag.current = {
          at: horizontal ? event.clientY : event.clientX,
          value,
          extent: horizontal ? (box?.height ?? 0) : (box?.width ?? 0),
        };
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          /* Pointer capture is optional when no pointer is active. */
        }
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start) return;
        const raw = horizontal ? start.at - event.clientY : event.clientX - start.at;
        const signed = invert ? -raw : raw;
        if (unit === "px") onChange(start.value + signed);
        else if (start.extent) onChange(start.value + (signed * 100) / start.extent);
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onKeyDown={(event) => {
        if (![negative, positive, "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        if (event.key === "Home") {
          onChange(min);
          return;
        }
        if (event.key === "End") {
          onChange(limit);
          return;
        }
        const direction = (invert ? -1 : 1) * (event.key === positive ? 1 : -1);
        onChange(value + direction * step);
      }}
    />
  );
}
