import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { _electron as electron, expect, test } from "@playwright/test";

const desktopDir = path.resolve(import.meta.dirname, "..");

/** The platform package the app loads; Linux CI installs it with the workspace. */
function missingDatabaseBinaries(): string | null {
  try {
    const wrapper = createRequire(path.join(desktopDir, "package.json")).resolve(
      "embedded-postgres",
    );
    const platform = process.platform === "win32" ? "windows" : process.platform;
    createRequire(wrapper).resolve(`@embedded-postgres/${platform}-${process.arch}`);
    return null;
  } catch {
    return "The embedded Postgres binaries for this platform are not installed.";
  }
}

const skipReason = missingDatabaseBinaries();
test.skip(skipReason !== null, skipReason ?? "");

let userData: string;
let app: ElectronApplication | undefined;

test.beforeEach(async () => {
  userData = await mkdtemp(path.join(tmpdir(), "ardurbot-desktop-local-"));
});

test.afterEach(async () => {
  // Quit stops the worker, the API, and the database before the process exits.
  await app?.close();
  app = undefined;
  // A failure keeps the services' own logs with the test output.
  const testInfo = test.info();
  if (testInfo.status !== testInfo.expectedStatus) {
    await cp(path.join(userData, "logs"), testInfo.outputPath("logs"), { recursive: true }).catch(
      () => undefined,
    );
  }
  await rm(userData, { recursive: true, force: true });
});

async function savedSetup() {
  try {
    return JSON.parse(await readFile(path.join(userData, "setup.json"), "utf8"));
  } catch {
    return null;
  }
}

test("a fresh install starts its own database and services, and opens the app after Continue", async () => {
  // A cold run compiles the API and worker sources before they answer.
  test.setTimeout(420_000);
  const env = { ...process.env, ARDURBOT_PERFORMANCE_USER_DATA: userData };
  // A stale ARDURBOT_WEB_URL from the developer's shell would bypass setup entirely.
  delete env.ARDURBOT_WEB_URL;
  app = await electron.launch({ args: ["."], cwd: desktopDir, env });
  const setup = await app.firstWindow();

  await expect(setup.getByRole("radio", { name: /This computer/ })).toBeChecked();
  await expect(setup.locator("#stack-phase")).toHaveText(
    /^(Starting the database|Preparing the database|Starting services)\.$/,
  );
  await expect(setup.locator("#stack-phase")).toHaveText("Ardur Bot is ready.", {
    timeout: 330_000,
  });
  // Nothing is saved until the person chooses Continue.
  expect(await savedSetup()).toBeNull();
  await setup.screenshot({
    path: path.join(import.meta.dirname, "screenshots", "11-setup-local-mode-ready.png"),
  });

  const appWindow = await Promise.all([
    app.waitForEvent("window"),
    setup.getByRole("button", { name: "Continue" }).click(),
  ]).then(([window]) => window);
  await expect(appWindow.locator('[data-ardurbot-app-state="ready"]')).toBeVisible({
    timeout: 60_000,
  });
  await expect.poll(savedSetup).toMatchObject({ mode: "new" });
  expect((await savedSetup()).serverUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  await appWindow.screenshot({
    path: path.join(import.meta.dirname, "screenshots", "12-local-mode-app.png"),
  });
});

test("a database without its settings offers Reset local data in the setup window", async () => {
  test.setTimeout(120_000);
  // A database is there but secrets.env is not; only a reset clears that.
  await mkdir(path.join(userData, "postgres"), { recursive: true });
  await writeFile(path.join(userData, "postgres", "PG_VERSION"), "18\n");
  const env = { ...process.env, ARDURBOT_PERFORMANCE_USER_DATA: userData };
  delete env.ARDURBOT_WEB_URL;
  app = await electron.launch({ args: ["."], cwd: desktopDir, env });
  const setup = await app.firstWindow();

  await expect(setup.locator("#stack-phase")).toHaveText(
    "The app's database settings are missing. Choose Reset local data, or restore secrets.env from a backup.",
    { timeout: 60_000 },
  );
  await expect(setup.getByRole("button", { name: "Reset local data", exact: true })).toBeVisible();
  await setup.screenshot({
    path: path.join(import.meta.dirname, "screenshots", "13-setup-local-mode-reset.png"),
  });
});
