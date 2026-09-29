// ready-to-show fires after the first paint. When the renderer never paints
// (a hung load, or a crash before the first frame) that event never comes.
// Three seconds covers a slow local cold start; after that the window opens
// anyway so a missed event cannot leave it hidden.
export const MAIN_WINDOW_SHOW_FALLBACK_MS = 3_000;

export type ShowableWindow = {
  show(): void;
  focus(): void;
  isDestroyed(): boolean;
  isVisible(): boolean;
  once(event: string, listener: () => void): void;
};

/**
 * Show a cold-start main window on its first paint, exactly once.
 * A dock click, a second instance, or the tray can show the same window
 * first; that show cancels the wait. Showing does not move, resize, or
 * unmaximize the window.
 */
export function showMainWindowWhenPainted(win: ShowableWindow): void {
  let opened = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stopWaiting = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };

  const open = () => {
    if (opened) return;
    opened = true;
    stopWaiting();
    if (win.isDestroyed()) return;
    win.show();
    if (!win.isDestroyed()) win.focus();
  };

  timer = setTimeout(open, MAIN_WINDOW_SHOW_FALLBACK_MS);
  win.once("ready-to-show", open);
  win.once("show", () => {
    // Ignore a show signal that did not actually reveal the window.
    if (win.isDestroyed() || !win.isVisible()) return;
    opened = true;
    stopWaiting();
  });
  win.once("closed", () => {
    opened = true;
    stopWaiting();
  });
}
