import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAIN_WINDOW_SHOW_FALLBACK_MS, showMainWindowWhenPainted } from "./main-window-show.js";
import type { WindowDisplay, WindowPlace } from "./window-place.js";
import {
  captureWindowPlace,
  restoreWindowPlace,
  WINDOW_PLACE_DEBOUNCE_MS,
  WINDOW_PLACE_FILE,
  WindowPlaceStore,
  watchWindowPlace,
  windowPlaceFrom,
  windowWithRestoredState,
} from "./window-place.js";

const defaults = { width: 1440, height: 900 };
const a: WindowDisplay = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 24, width: 1920, height: 1016 },
  primary: true,
};
const b: WindowDisplay = {
  id: 2,
  bounds: { x: 1920, y: 0, width: 1920, height: 1080 },
  workArea: { x: 1920, y: 0, width: 1920, height: 1040 },
  primary: false,
};
const normal: WindowPlace = {
  x: 100,
  y: 120,
  width: 1000,
  height: 700,
  maximized: false,
  fullScreen: false,
  displayId: 1,
};
const centred = { x: 240, y: 82, ...defaults };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("display-aware normal bounds", () => {
  it.each([
    {
      name: "fully inside A",
      saved: normal,
      displays: [a, b],
      bounds: { x: 100, y: 120, width: 1000, height: 700 },
    },
    {
      name: "fully inside B",
      saved: { ...normal, x: 2050, displayId: 2 },
      displays: [a, b],
      bounds: { x: 2050, y: 120, width: 1000, height: 700 },
    },
    {
      name: "unplugged B",
      saved: { ...normal, x: 2050, displayId: 2 },
      displays: [a],
      bounds: centred,
    },
    {
      name: "200 pixels of title area at right edge",
      saved: { ...normal, x: 1720 },
      displays: [a],
      bounds: { x: 920, y: 120, width: 1000, height: 700 },
    },
    {
      name: "199 pixels at right edge",
      saved: { ...normal, x: 1721 },
      displays: [a],
      bounds: centred,
    },
    {
      name: "body visible but title area above screen",
      saved: { ...normal, y: -100 },
      displays: [a],
      bounds: centred,
    },
    {
      name: "partly reachable top band in B",
      saved: { ...normal, x: 2000, y: -50, displayId: 2 },
      displays: [a, b],
      bounds: { x: 2000, y: 0, width: 1000, height: 700 },
    },
    {
      name: "saved maximized",
      saved: { ...normal, maximized: true },
      displays: [a],
      bounds: { x: 100, y: 120, width: 1000, height: 700 },
    },
    {
      name: "saved full-screen",
      saved: { ...normal, fullScreen: true },
      displays: [a],
      bounds: { x: 100, y: 120, width: 1000, height: 700 },
    },
    {
      name: "bottom overflow keeps size and shifts up",
      saved: { ...normal, y: 900 },
      displays: [a],
      bounds: { x: 100, y: 340, width: 1000, height: 700 },
    },
    {
      name: "right and bottom overflow shift both edges",
      saved: { ...normal, x: 1720, y: 900 },
      displays: [a],
      bounds: { x: 920, y: 340, width: 1000, height: 700 },
    },
    {
      name: "top band partly under menu keeps size and shifts down",
      saved: { ...normal, y: 10 },
      displays: [a],
      bounds: { x: 100, y: 24, width: 1000, height: 700 },
    },
    {
      name: "left overflow shifts right",
      saved: { ...normal, x: -50 },
      displays: [a],
      bounds: { x: 0, y: 120, width: 1000, height: 700 },
    },
    {
      name: "oversized width shrinks but usable height is retained",
      saved: { ...normal, width: 3000, y: 900 },
      displays: [a],
      bounds: { x: 0, y: 340, width: 1920, height: 700 },
    },
    {
      name: "negative-origin bottom and right overflow",
      saved: { ...normal, x: -300, y: -150 },
      displays: [{ ...a, workArea: { x: -1920, y: -1040, width: 1920, height: 1016 } }],
      bounds: { x: -1000, y: -724, width: 1000, height: 700 },
    },
    {
      name: "connected saved display wins after rearrangement",
      saved: { ...normal, displayId: 2 },
      displays: [a, b],
      bounds: { x: 2160, y: 70, ...defaults },
    },
    {
      name: "connected display wins over primary for unusable coordinates",
      saved: { ...normal, x: 9000, displayId: 2 },
      displays: [a, b],
      bounds: { x: 2160, y: 70, ...defaults },
    },
    {
      name: "missing display uses saved-centre display before primary",
      saved: { ...normal, x: 2000, y: -200, displayId: 99 },
      displays: [a, b],
      bounds: { x: 2160, y: 70, ...defaults },
    },
    { name: "missing state", saved: null, displays: [b, a], bounds: centred },
    {
      name: "oversized normal rectangle",
      saved: { ...normal, width: 3000, height: 2000 },
      displays: [a],
      bounds: a.workArea,
    },
    {
      name: "oversized default on small display",
      saved: null,
      displays: [{ ...a, workArea: { x: 0, y: 40, width: 800, height: 560 } }],
      bounds: { x: 0, y: 40, width: 800, height: 560 },
    },
    {
      name: "negative display coordinates",
      saved: { ...normal, x: -1500, displayId: 3 },
      displays: [
        {
          ...b,
          bounds: { x: -1920, y: -1080, width: 1920, height: 2160 },
          workArea: { x: -1920, y: -1040, width: 1920, height: 2080 },
        },
        a,
      ],
      bounds: { x: -1500, y: 120, width: 1000, height: 700 },
    },
    {
      name: "no available displays",
      saved: null,
      displays: [],
      bounds: { x: 0, y: 0, ...defaults },
    },
  ])("$name", ({ saved, displays, bounds }) => {
    const result = restoreWindowPlace(saved, displays, defaults);
    expect(result).toEqual({
      bounds,
      maximized: saved?.maximized ?? false,
      fullScreen: saved?.fullScreen ?? false,
    });
  });

  it.each([
    { name: "macOS menu and dock", workArea: { x: 0, y: 38, width: 1920, height: 1000 } },
    { name: "Windows left taskbar", workArea: { x: 48, y: 0, width: 1872, height: 1080 } },
    { name: "Linux top panel", workArea: { x: 0, y: 32, width: 1920, height: 1048 } },
  ])("centres in the $name work area, not the physical display", ({ workArea }) => {
    expect(restoreWindowPlace(null, [{ ...a, workArea }], defaults).bounds).toEqual({
      x: workArea.x + Math.floor((workArea.width - defaults.width) / 2),
      y: workArea.y + Math.floor((workArea.height - defaults.height) / 2),
      ...defaults,
    });
  });

  it("keeps flags but makes off-screen maximized normal bounds safe", () => {
    expect(
      restoreWindowPlace({ ...normal, x: 9000, maximized: true, fullScreen: true }, [a], defaults),
    ).toEqual({
      bounds: centred,
      maximized: true,
      fullScreen: true,
    });
  });

  it.each([
    {},
    [],
    null,
    { ...normal, x: NaN },
    { ...normal, width: 0 },
    { ...normal, height: -1 },
    { ...normal, y: 0.5 },
    { ...normal, width: Infinity },
    { ...normal, x: 2 ** 40 },
    { ...normal, maximized: "yes" },
    { ...normal, fullScreen: 1 },
    { ...normal, displayId: null },
  ])("rejects malformed native state %j", (value) => {
    expect(windowPlaceFrom(value)).toBeNull();
  });

  it("accepts native display identifiers wider than signed 32-bit coordinates", () => {
    expect(windowPlaceFrom({ ...normal, displayId: 4294967295 })).toEqual({
      ...normal,
      displayId: 4294967295,
    });
  });

  it("drops unrelated fields", () => {
    expect(windowPlaceFrom({ ...normal, extra: "not placement" })).toEqual(normal);
  });
});

class WindowFake extends EventEmitter {
  bounds = { x: normal.x, y: normal.y, width: normal.width, height: normal.height };
  maximized = false;
  fullScreen = false;
  destroyed = false;
  visible = false;
  getNormalBounds = vi.fn(() => this.bounds);
  getBounds = vi.fn(() => a.bounds);
  isMaximized = () => this.maximized;
  isFullScreen = () => this.fullScreen;
  isDestroyed = () => this.destroyed;
  isVisible = () => this.visible;
  show = vi.fn(() => {
    this.visible = true;
    this.emit("show");
  });
  focus = vi.fn();
  maximize = vi.fn(() => {
    this.maximized = true;
    this.show();
  });
  setFullScreen = vi.fn((value: boolean) => {
    this.fullScreen = value;
  });
}
const displayScreen = { getDisplayMatching: vi.fn(() => ({ id: 2 })) };

describe("Electron edge without Electron", () => {
  it("captures normal bounds and the matching display while maximized", () => {
    const win = new WindowFake();
    win.maximized = true;
    win.fullScreen = true;
    expect(captureWindowPlace(win, displayScreen)).toEqual({
      ...normal,
      maximized: true,
      fullScreen: true,
      displayId: 2,
    });
    expect(win.getNormalBounds).toHaveBeenCalledOnce();
    expect(win.getBounds).not.toHaveBeenCalled();
    expect(displayScreen.getDisplayMatching).toHaveBeenCalledWith(win.bounds);
  });

  it.each(["ready-to-show", "fallback", "early activation"] as const)(
    "restores state once at %s without an early maximize reveal",
    (trigger) => {
      vi.useFakeTimers();
      const win = new WindowFake();
      const placed = windowWithRestoredState(win, { maximized: true, fullScreen: true });
      showMainWindowWhenPainted(placed);
      expect(win.maximize).not.toHaveBeenCalled();
      expect(win.setFullScreen).not.toHaveBeenCalled();
      expect(win.show).not.toHaveBeenCalled();
      if (trigger === "ready-to-show") win.emit("ready-to-show");
      if (trigger === "fallback") vi.advanceTimersByTime(MAIN_WINDOW_SHOW_FALLBACK_MS);
      if (trigger === "early activation") win.show();
      expect(win.maximize).toHaveBeenCalledOnce();
      expect(win.setFullScreen).toHaveBeenCalledExactlyOnceWith(true);
      expect(win.maximized).toBe(true);
      expect(win.fullScreen).toBe(true);
      win.emit("ready-to-show");
      vi.advanceTimersByTime(MAIN_WINDOW_SHOW_FALLBACK_MS);
      expect(win.maximize).toHaveBeenCalledOnce();
      expect(win.setFullScreen).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["ready-to-show", "fallback", "early activation"] as const)(
    "shows before requesting full-screen at %s and preserves state until entry settles",
    (trigger) => {
      vi.useFakeTimers();
      const win = new WindowFake();
      const order: string[] = [];
      win.show.mockImplementation(() => {
        order.push("show");
        win.visible = true;
        win.emit("resize");
        win.emit("show");
      });
      win.setFullScreen.mockImplementation(() => {
        expect(win.isVisible()).toBe(true);
        order.push("full-screen");
        // Model a macOS transition longer than the save debounce.
        win.emit("resize");
      });
      const store = new WindowPlaceStore("/unused");
      store.current = { ...normal, fullScreen: true };
      const save = vi.spyOn(store, "save").mockResolvedValue();
      watchWindowPlace(win, store, displayScreen, () => true);
      const placed = windowWithRestoredState(win, store.current);
      showMainWindowWhenPainted(placed);
      win.emit("move");
      vi.advanceTimersByTime(WINDOW_PLACE_DEBOUNCE_MS);
      expect(save).not.toHaveBeenCalled();
      if (trigger === "ready-to-show") win.emit("ready-to-show");
      if (trigger === "fallback") vi.advanceTimersByTime(MAIN_WINDOW_SHOW_FALLBACK_MS);
      if (trigger === "early activation") win.show();
      expect(order).toEqual(["show", "full-screen"]);
      vi.advanceTimersByTime(WINDOW_PLACE_DEBOUNCE_MS * 2);
      win.emit("close");
      expect(save).not.toHaveBeenCalled();
      expect(store.current.fullScreen).toBe(true);
      win.fullScreen = true;
      win.emit("enter-full-screen");
      vi.advanceTimersByTime(WINDOW_PLACE_DEBOUNCE_MS);
      expect(save).toHaveBeenCalledExactlyOnceWith({ ...normal, fullScreen: true, displayId: 2 });
      win.fullScreen = false;
      win.emit("leave-full-screen");
      vi.advanceTimersByTime(WINDOW_PLACE_DEBOUNCE_MS);
      expect(save).toHaveBeenLastCalledWith({ ...normal, fullScreen: false, displayId: 2 });
      expect(win.setFullScreen).toHaveBeenCalledOnce();
      win.emit("closed");
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not restore state after a window is destroyed", () => {
    vi.useFakeTimers();
    const win = new WindowFake();
    showMainWindowWhenPainted(windowWithRestoredState(win, normal));
    win.destroyed = true;
    win.emit("closed");
    vi.advanceTimersByTime(MAIN_WINDOW_SHOW_FALLBACK_MS);
    expect(win.show).not.toHaveBeenCalled();
    expect(win.maximize).not.toHaveBeenCalled();
  });

  it("debounces moves/resizes, captures latest geometry, then saves immediately on close", async () => {
    vi.useFakeTimers();
    const win = new WindowFake();
    const store = new WindowPlaceStore("/unused");
    const save = vi.spyOn(store, "save").mockResolvedValue();
    watchWindowPlace(win, store, displayScreen, () => true);
    win.emit("move");
    vi.advanceTimersByTime(400);
    win.bounds = { ...win.bounds, x: 300 };
    win.emit("resize");
    vi.advanceTimersByTime(WINDOW_PLACE_DEBOUNCE_MS - 1);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(save).toHaveBeenCalledExactlyOnceWith({ ...normal, x: 300, displayId: 2 });
    win.emit("move");
    win.maximized = true;
    win.emit("close");
    expect(save).toHaveBeenLastCalledWith({ ...normal, x: 300, maximized: true, displayId: 2 });
    expect(save).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("saves a move-only drag to another display after the debounce", () => {
    vi.useFakeTimers();
    const win = new WindowFake();
    const store = new WindowPlaceStore("/unused");
    const save = vi.spyOn(store, "save").mockResolvedValue();
    watchWindowPlace(win, store, displayScreen, () => true);
    win.bounds = { ...win.bounds, x: 2050 };
    win.emit("move");
    vi.advanceTimersByTime(WINDOW_PLACE_DEBOUNCE_MS - 1);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(save).toHaveBeenCalledExactlyOnceWith({ ...normal, x: 2050, displayId: 2 });
  });

  it.each(["maximize", "unmaximize", "enter-full-screen", "leave-full-screen"])(
    "also saves %s state changes without relying on a resize",
    (event) => {
      vi.useFakeTimers();
      const win = new WindowFake();
      const store = new WindowPlaceStore("/unused");
      const save = vi.spyOn(store, "save").mockResolvedValue();
      watchWindowPlace(win, store, displayScreen, () => true);
      win.emit(event);
      vi.advanceTimersByTime(WINDOW_PLACE_DEBOUNCE_MS);
      expect(save).toHaveBeenCalledOnce();
    },
  );

  it("cancels pending capture on destruction and does not let superseded windows write", () => {
    vi.useFakeTimers();
    const win = new WindowFake();
    const store = new WindowPlaceStore("/unused");
    const save = vi.spyOn(store, "save").mockResolvedValue();
    let current = true;
    watchWindowPlace(win, store, displayScreen, () => current);
    win.emit("move");
    current = false;
    vi.advanceTimersByTime(WINDOW_PLACE_DEBOUNCE_MS);
    win.emit("close");
    expect(save).not.toHaveBeenCalled();
    current = true;
    win.emit("resize");
    win.destroyed = true;
    win.emit("closed");
    expect(vi.getTimerCount()).toBe(0);
    expect(save).not.toHaveBeenCalled();
  });
});

describe("placement persistence", () => {
  const directories: string[] = [];
  async function directory() {
    const dir = await mkdtemp(path.join(tmpdir(), "ardur-window-place-"));
    directories.push(dir);
    return dir;
  }
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it.each([null, "{ corrupt", "[]", '{"width": 900}', " ".repeat(4097)])(
    "loads defaults for missing, corrupt, invalid or oversized state",
    async (raw) => {
      const dir = await directory();
      if (raw !== null) await writeFile(path.join(dir, WINDOW_PLACE_FILE), raw);
      const store = new WindowPlaceStore(dir);
      await store.load();
      expect(store.current).toBeNull();
      expect(restoreWindowPlace(store.current, [a], defaults).bounds).toEqual(centred);
    },
  );

  it("serializes atomic saves, preserves the latest state and leaves no temporary files", async () => {
    const dir = await directory();
    const store = new WindowPlaceStore(dir);
    const first = store.save(normal);
    const next = { ...normal, x: 200, maximized: true, fullScreen: true };
    const second = store.save(next);
    expect(store.writing).toBe(true);
    expect(store.current).toEqual(next);
    await store.flush();
    await Promise.all([first, second]);
    expect(store.writing).toBe(false);
    const restored = new WindowPlaceStore(dir);
    await restored.load();
    expect(restored.current).toEqual(next);
    expect(JSON.parse(await readFile(path.join(dir, WINDOW_PLACE_FILE), "utf8"))).toEqual(next);
    expect(await readdir(dir)).toEqual([WINDOW_PLACE_FILE]);
    if (process.platform !== "win32")
      expect((await stat(path.join(dir, WINDOW_PLACE_FILE))).mode & 0o777).toBe(0o600);
  });

  it("snapshots native geometry before queued writes", async () => {
    const dir = await directory();
    const store = new WindowPlaceStore(dir);
    const place = { ...normal };
    const saved = store.save(place);
    place.x = 9000;
    await saved;
    const restored = new WindowPlaceStore(dir);
    await restored.load();
    expect(restored.current).toEqual(normal);
  });

  it("does not follow a final symlink on read or write", async () => {
    const dir = await directory();
    const other = path.join(dir, "other.json");
    await writeFile(other, JSON.stringify(normal));
    await symlink(other, path.join(dir, WINDOW_PLACE_FILE));
    const store = new WindowPlaceStore(dir);
    await store.load();
    expect(store.current).toBeNull();
    await store.save({ ...normal, x: 200 });
    expect(JSON.parse(await readFile(other, "utf8"))).toEqual(normal);
    expect(JSON.parse(await readFile(path.join(dir, WINDOW_PLACE_FILE), "utf8")).x).toBe(200);
  });

  it("settles failed writes without blocking close, logging paths or losing in-memory geometry", async () => {
    const dir = await directory();
    const file = path.join(dir, "not-a-directory");
    await writeFile(file, "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new WindowPlaceStore(file);
    await expect(store.save(normal)).resolves.toBeUndefined();
    await store.flush();
    expect(store.writing).toBe(false);
    expect(store.current).toEqual(normal);
    expect(warn).toHaveBeenCalledExactlyOnceWith("Could not save window placement.");
  });
});

it("waits for the final close write before app quit", async () => {
  const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
  const start = source.indexOf('app.on("will-quit", (event) => {');
  const end = source.indexOf("\n});", start) + "\n});".length;
  expect(start).toBeGreaterThan(0);
  let handler: (event: { preventDefault: () => void }) => void = () => {};
  let finish = () => {};
  const windowPlace = {
    writing: true,
    flush: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    ),
  };
  const quit = vi.fn();
  const stop = vi.fn();
  const context = {
    app: {
      on: (_event: string, listener: typeof handler) => {
        handler = listener;
      },
      quit,
    },
    windowPlace,
    guidedEngine: undefined,
    legacyCompose: true,
    hostService: { stop },
    guidedIpcCleanup: null,
    desktopTray: null,
    clearTimeout: vi.fn(),
    warmWindowTimer: undefined,
    remoteListener: { stop: vi.fn() },
    localStack: undefined,
  };
  vm.runInNewContext(stripTypeScriptTypes(source.slice(start, end)), context);
  const event = { preventDefault: vi.fn() };
  handler(event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(quit).not.toHaveBeenCalled();
  expect(stop).not.toHaveBeenCalled();
  windowPlace.writing = false;
  finish();
  await Promise.resolve();
  expect(quit).toHaveBeenCalledOnce();
  handler({ preventDefault: vi.fn() });
  expect(stop).toHaveBeenCalledOnce();
});
