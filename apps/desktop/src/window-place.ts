import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { BrowserWindow, Rectangle, screen } from "electron";
import type { ShowableWindow } from "./main-window-show.js";
import { readPrivateFile, writePrivateFile } from "./setup-store.js";

export const WINDOW_PLACE_FILE = "window-place.json";
export const WINDOW_PLACE_DEBOUNCE_MS = 500;

// Native full-screen entry is asynchronous. Keep the saved state until Electron confirms it.
const restoringFullScreen = new WeakSet<object>();

export type WindowPlace = Rectangle & {
  maximized: boolean;
  fullScreen: boolean;
  displayId: number;
};

export type WindowDisplay = {
  id: number;
  bounds: Rectangle;
  workArea: Rectangle;
  primary: boolean;
};

function coordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && Math.abs(value) <= 2_147_483_647;
}

/** Keep only bounded native geometry and state; malformed state is not a placement. */
export function windowPlaceFrom(value: unknown): WindowPlace | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const { x, y, width, height, maximized, fullScreen, displayId } = record;
  if (
    !coordinate(x) ||
    !coordinate(y) ||
    !coordinate(width) ||
    !coordinate(height) ||
    width <= 0 ||
    height <= 0 ||
    typeof maximized !== "boolean" ||
    typeof fullScreen !== "boolean" ||
    typeof displayId !== "number" ||
    !Number.isSafeInteger(displayId)
  )
    return null;
  return { x, y, width, height, maximized, fullScreen, displayId };
}

function titleAreaVisible(saved: Rectangle, area: Rectangle): boolean {
  const width = Math.min(saved.x + saved.width, area.x + area.width) - Math.max(saved.x, area.x);
  const topHeight = Math.min(100, saved.height);
  const height = Math.min(saved.y + topHeight, area.y + area.height) - Math.max(saved.y, area.y);
  return width >= Math.min(200, saved.width) && height > 0;
}

function containsCentre(area: Rectangle, saved: Rectangle): boolean {
  const x = saved.x + saved.width / 2;
  const y = saved.y + saved.height / 2;
  return x >= area.x && x < area.x + area.width && y >= area.y && y < area.y + area.height;
}

/** Geometry uses Electron's device-independent coordinates, including negative display origins. */
export function restoreWindowPlace(
  saved: WindowPlace | null | undefined,
  displays: readonly WindowDisplay[],
  defaults: Pick<Rectangle, "width" | "height">,
): { bounds: Rectangle; maximized: boolean; fullScreen: boolean } {
  const valid = saved;
  const usable = displays.filter(
    (display) => display.workArea.width > 0 && display.workArea.height > 0,
  );
  const remembered = valid ? usable.find((display) => display.id === valid.displayId) : undefined;
  const visible = valid
    ? (remembered ? [remembered] : usable).find((display) =>
        titleAreaVisible(valid, display.workArea),
      )
    : undefined;
  const display =
    visible ??
    remembered ??
    (valid ? usable.find((candidate) => containsCentre(candidate.bounds, valid)) : undefined) ??
    usable.find((candidate) => candidate.primary) ??
    usable[0];
  const area = display?.workArea ?? { x: 0, y: 0, ...defaults };
  const size = visible && valid ? valid : defaults;
  const width = Math.min(size.width, area.width);
  const height = Math.min(size.height, area.height);
  let x = visible && valid ? valid.x : area.x + Math.floor((area.width - width) / 2);
  let y = visible && valid ? valid.y : area.y + Math.floor((area.height - height) / 2);
  // Shift a usable rectangle before shrinking it, keeping every edge (and the composer) reachable.
  x = Math.max(area.x, Math.min(x, area.x + area.width - width));
  y = Math.max(area.y, Math.min(y, area.y + area.height - height));
  return {
    bounds: { x, y, width, height },
    maximized: valid?.maximized ?? false,
    fullScreen: valid?.fullScreen ?? false,
  };
}

type PlaceWindow = Pick<BrowserWindow, "getNormalBounds" | "isMaximized" | "isFullScreen">;

/** Never save the maximized/full-screen rectangle as the user's normal size. */
export function captureWindowPlace(
  win: PlaceWindow,
  displayScreen: Pick<typeof screen, "getDisplayMatching">,
): WindowPlace {
  const bounds = win.getNormalBounds();
  return {
    ...bounds,
    maximized: win.isMaximized(),
    fullScreen: win.isFullScreen(),
    displayId: displayScreen.getDisplayMatching(bounds).id,
  };
}

/** Validate untrusted disk state once on load; native captures are already typed.
 * Bounded reads and serialized atomic writes reuse the desktop state-file boundary.
 */
export class WindowPlaceStore {
  current: WindowPlace | null = null;
  private writes: Promise<void> = Promise.resolve();
  private pending = 0;

  constructor(private readonly directory: string) {}

  async load(): Promise<void> {
    const raw = await readPrivateFile(path.join(this.directory, WINDOW_PLACE_FILE), 4096);
    try {
      this.current = raw === null ? null : windowPlaceFrom(JSON.parse(raw));
    } catch {
      this.current = null;
    }
  }

  save(place: WindowPlace): Promise<void> {
    const next = { ...place };
    this.current = next;
    this.pending++;
    this.writes = this.writes.then(async () => {
      try {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await writePrivateFile(path.join(this.directory, WINDOW_PLACE_FILE), JSON.stringify(next));
      } catch {
        // Placement is optional: a read-only or unavailable profile never blocks closing.
        console.warn("Could not save window placement.");
      } finally {
        this.pending--;
      }
    });
    return this.writes;
  }

  get writing(): boolean {
    return this.pending > 0;
  }

  flush(): Promise<void> {
    return this.writes;
  }
}

/** Only the current main window may replace placement when app windows overlap. */
export function watchWindowPlace(
  win: PlaceWindow & Pick<BrowserWindow, "on" | "isDestroyed">,
  store: WindowPlaceStore,
  displayScreen: Pick<typeof screen, "getDisplayMatching">,
  isCurrent: () => boolean,
): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const save = () => {
    stop();
    if (!win.isDestroyed() && isCurrent() && !restoringFullScreen.has(win))
      void store.save(captureWindowPlace(win, displayScreen));
  };
  const schedule = () => {
    stop();
    timer = setTimeout(save, WINDOW_PLACE_DEBOUNCE_MS);
    timer.unref();
  };
  win.on("move", schedule);
  win.on("resize", schedule);
  win.on("maximize", schedule);
  win.on("unmaximize", schedule);
  win.on("enter-full-screen", schedule);
  win.on("leave-full-screen", schedule);
  win.on("close", save);
  win.on("closed", stop);
}

/**
 * maximize() also reveals hidden Electron windows. Apply saved state at the first
 * reveal, not during construction, so the existing paint wait and fallback own timing.
 * Full-screen entry must follow show; ordered-out macOS windows can drop that toggle.
 */
export function windowWithRestoredState(
  win: ShowableWindow & Pick<BrowserWindow, "maximize" | "setFullScreen">,
  place: Pick<WindowPlace, "maximized" | "fullScreen">,
): ShowableWindow {
  let restored = false;
  if (place.fullScreen) {
    restoringFullScreen.add(win);
    win.once("enter-full-screen", () => restoringFullScreen.delete(win));
    win.once("closed", () => restoringFullScreen.delete(win));
  }
  const restore = () => {
    if (restored || win.isDestroyed() || !win.isVisible()) return;
    restored = true;
    if (place.maximized) win.maximize();
    if (place.fullScreen) win.setFullScreen(true);
  };
  // Dock/tray activation can intentionally show the window before its first paint.
  win.once("show", restore);
  return {
    show: () => {
      if (win.isDestroyed()) return;
      if (!win.isVisible()) win.show();
      restore();
    },
    focus: () => win.focus(),
    isDestroyed: () => win.isDestroyed(),
    isVisible: () => win.isVisible(),
    once: (event, listener) => win.once(event, listener),
  };
}
