import { useRef } from "react";

export function Splitter({
  label,
  horizontal = false,
  value,
  onChange,
}: {
  label: string;
  horizontal?: boolean;
  value: number;
  onChange(value: number): void;
}) {
  const drag = useRef<{ at: number; value: number; extent: number } | null>(null);
  return (
    <hr
      tabIndex={0}
      aria-label={label}
      aria-orientation={horizontal ? "horizontal" : "vertical"}
      aria-valuenow={Math.round(value)}
      aria-valuemin={15}
      aria-valuemax={horizontal ? 65 : 40}
      className={
        horizontal
          ? "m-0 h-1 border-0 shrink-0 cursor-row-resize touch-none bg-border hover:bg-primary focus-visible:bg-primary"
          : "m-0 h-full w-1 border-0 shrink-0 cursor-col-resize touch-none bg-border hover:bg-primary focus-visible:bg-primary"
      }
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        const box = event.currentTarget.parentElement!.getBoundingClientRect();
        drag.current = {
          at: horizontal ? event.clientY : event.clientX,
          value,
          extent: horizontal ? box.height : box.width,
        };
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (start?.extent)
          onChange(
            start.value +
              ((horizontal ? start.at - event.clientY : event.clientX - start.at) * 100) /
                start.extent,
          );
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onKeyDown={(event) => {
        const negative = horizontal ? "ArrowDown" : "ArrowLeft";
        const positive = horizontal ? "ArrowUp" : "ArrowRight";
        if ([negative, positive, "Home", "End"].includes(event.key)) {
          event.preventDefault();
          onChange(
            event.key === "Home"
              ? 15
              : event.key === "End"
                ? horizontal
                  ? 65
                  : 40
                : value + (event.key === positive ? 2 : -2),
          );
        }
      }}
    />
  );
}
