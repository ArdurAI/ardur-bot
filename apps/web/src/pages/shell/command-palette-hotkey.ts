export function isCommandPaletteHotkey(event: KeyboardEvent) {
  if (
    typeof Element !== "undefined" &&
    event.target instanceof Element &&
    event.target.closest("[data-terminal-root]")
  )
    return false;
  if (event.repeat || event.altKey || event.shiftKey) return false;
  if (!(event.metaKey || event.ctrlKey)) return false;
  return event.key.toLowerCase() === "k";
}
