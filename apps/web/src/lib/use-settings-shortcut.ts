import { useEffect } from "react";

export function useSettingsShortcut(openSettings: () => void) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (
        event.key !== "," ||
        (!event.metaKey && !event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        event.repeat ||
        event.isComposing
      )
        return;
      event.preventDefault();
      openSettings();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openSettings]);
}
