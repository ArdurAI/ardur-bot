import { useEffect, useState } from "react";

function getLocalDayKey(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function msUntilNextMidnight(now: Date = new Date()): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return Math.max(next.getTime() - now.getTime(), 1);
}

export function useLocalDayTick(): string {
  const [dayKey, setDayKey] = useState(() => getLocalDayKey());

  useEffect(() => {
    let timerId: ReturnType<typeof setTimeout> | undefined;

    const scheduleNextTick = () => {
      if (timerId !== undefined) {
        clearTimeout(timerId);
      }
      const delay = msUntilNextMidnight();
      timerId = setTimeout(() => {
        setDayKey(getLocalDayKey());
        scheduleNextTick();
      }, delay);
    };

    scheduleNextTick();

    const handleVisibilityChange = () => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        setDayKey(getLocalDayKey());
        scheduleNextTick();
      }
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }

    return () => {
      if (timerId !== undefined) {
        clearTimeout(timerId);
      }
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
    };
  }, []);

  return dayKey;
}
