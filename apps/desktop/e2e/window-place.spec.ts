import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { _electron as electron, expect, test } from "@playwright/test";

const fixture =
  '<!doctype html><html lang="en"><head><title>Ardur</title></head><body><main>Window placement fixture ready</main></body></html>';
let userData: string;
let app: ElectronApplication | undefined;

test.beforeEach(async () => {
  userData = await mkdtemp(path.join(tmpdir(), "ardur-window-place-e2e-"));
});

test.afterEach(async () => {
  await app?.close();
  app = undefined;
  await rm(userData, { recursive: true, force: true });
});

async function launch() {
  app = await electron.launch({
    args: ["."],
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      ARDURBOT_USER_DATA_DIR: userData,
      ARDURBOT_WEB_URL: `data:text/html;charset=utf-8,${encodeURIComponent(fixture)}`,
      ARDURBOT_DISABLE_WARM_WINDOW: "1",
    },
  });
  const page = await app.firstWindow();
  await expect(page.getByText("Window placement fixture ready")).toBeVisible();
  return page;
}

test("flushes a chosen normal rectangle on immediate quit and restores it after restart", async () => {
  await launch();
  const closed = app!.waitForEvent("close");
  const bounds = await app!.evaluate(({ app, BrowserWindow, screen }) => {
    const area = screen.getPrimaryDisplay().workArea;
    const win = BrowserWindow.getAllWindows()[0]!;
    win.setBounds({
      x: area.x + 60,
      y: area.y + 70,
      width: Math.min(800, area.width - 100),
      height: Math.min(600, area.height - 100),
    });
    const normal = win.getNormalBounds();
    // Quit in the same main-process turn as setBounds, before the debounce can fire.
    app.quit();
    return normal;
  });
  await closed;
  app = undefined;
  const saved = JSON.parse(await readFile(path.join(userData, "window-place.json"), "utf8"));
  expect({ x: saved.x, y: saved.y, width: saved.width, height: saved.height }).toEqual(bounds);
  await launch();
  await expect
    .poll(() =>
      app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getNormalBounds()),
    )
    .toEqual(bounds);
});

test("opens reachable default bounds when the saved display is gone", async () => {
  await writeFile(
    path.join(userData, "window-place.json"),
    JSON.stringify({
      x: 1000000,
      y: 1000000,
      width: 1000,
      height: 700,
      maximized: false,
      fullScreen: false,
      displayId: -999,
    }),
  );
  await launch();
  const actual = await app!.evaluate(({ BrowserWindow, screen }) => ({
    bounds: BrowserWindow.getAllWindows()[0]!.getNormalBounds(),
    area: screen.getPrimaryDisplay().workArea,
  }));
  const width = Math.min(1440, actual.area.width);
  const height = Math.min(900, actual.area.height);
  expect(actual.bounds).toEqual({
    x: actual.area.x + Math.floor((actual.area.width - width) / 2),
    y: actual.area.y + Math.floor((actual.area.height - height) / 2),
    width,
    height,
  });
});
