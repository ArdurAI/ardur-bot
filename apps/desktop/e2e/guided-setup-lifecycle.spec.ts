import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { GUIDED_SETUP_FIXTURE_REQUEST_CHANNELS } from "./guided-setup-fixture-channels.js";

test("cancel settles during services start and re-check preserves the owned receipt", async () => {
  test.setTimeout(60_000);
  const userData = await mkdtemp(path.join(tmpdir(), "ardur-guided-lifecycle-"));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.ARDURBOT_PERFORMANCE_USER_DATA = userData;
  env.ARDURBOT_GUIDED_SETUP = "1";
  delete env.ARDURBOT_WEB_URL;
  const executablePath = process.env.ARDURBOT_E2E_EXECUTABLE;
  const desktop = await electron.launch({
    ...(executablePath ? { executablePath: path.resolve(executablePath) } : {}),
    args: executablePath ? [] : ["."],
    cwd: path.resolve(import.meta.dirname, ".."),
    env,
  });
  try {
    const setup = await desktop.firstWindow();
    await expect(setup.getByRole("heading", { name: "Set up Ardur" })).toBeVisible();
    await desktop.evaluate(async ({ app, BrowserWindow, ipcMain }, requestChannels) => {
      const { join } = await import("node:path");
      const { pathToFileURL } = await import("node:url");
      const moduleUrl = (name: string) =>
        pathToFileURL(join(app.getAppPath(), "dist", "guided-setup", name)).href;
      const { SetupEngine } = await import(moduleUrl("engine.js"));
      const { SetupJournalStore } = await import(moduleUrl("store.js"));
      const { installGuidedSetupIpc } = await import(moduleUrl("ipc.js"));
      let raw: string | null = null;
      let healthy = false;
      let serviceRuns = 0;
      let release: (() => void) | null = null;
      const ready = async () => ({ kind: "satisfied" as const, checkedAt: 1, evidence: "checked" });
      const noMutation = async () => ({ kind: "verified" as const, proof: "checked" });
      const noCancel = async () => undefined;
      const engine = await SetupEngine.open(
        new SetupJournalStore("/fixture", {
          read: async () => raw,
          write: async (_file: string, text: string) => {
            raw = text;
          },
          exists: async () => raw !== null,
          ensure: async () => undefined,
        }),
        [
          {
            id: "prerequisites",
            revision: 1,
            requires: [],
            canSkip: false,
            check: ready,
            run: noMutation,
            verify: ready,
            cancel: noCancel,
          },
          {
            id: "database",
            revision: 1,
            requires: ["prerequisites"],
            canSkip: false,
            check: ready,
            run: noMutation,
            verify: ready,
            cancel: noCancel,
          },
          {
            id: "migrations",
            revision: 1,
            requires: ["database"],
            canSkip: false,
            check: ready,
            run: noMutation,
            verify: ready,
            cancel: noCancel,
          },
          {
            id: "command",
            revision: 1,
            requires: ["migrations"],
            canSkip: true,
            check: async () => ({
              kind: "notApplicable" as const,
              reasonCode: "command-unavailable",
            }),
            run: noMutation,
            verify: ready,
            cancel: noCancel,
          },
          {
            id: "services",
            revision: 1,
            requires: ["migrations"],
            canSkip: false,
            waitForInput: true,
            check: async () =>
              healthy
                ? { kind: "satisfied" as const, checkedAt: 1, evidence: "services:fixture" }
                : { kind: "needed" as const, reasonCode: "services-not-ready" },
            run: async (_context: unknown, signal: AbortSignal) => {
              serviceRuns += 1;
              await new Promise<void>((resolve) => {
                release = resolve;
                signal.addEventListener("abort", () => resolve(), { once: true });
              });
              return { kind: "owned" as const, proof: "services:fixture" };
            },
            verify: async () => ({
              kind: "satisfied" as const,
              checkedAt: 1,
              evidence: "services:fixture",
            }),
            cancel: async () => {
              healthy = false;
              release?.();
            },
          },
          {
            id: "engines",
            revision: 1,
            requires: ["services"],
            canSkip: true,
            check: async () => ({
              kind: "needed" as const,
              reasonCode: "optional-computers-unchecked",
            }),
            run: noMutation,
            verify: ready,
            cancel: noCancel,
          },
        ],
      );
      for (const channel of requestChannels) ipcMain.removeHandler(channel);
      installGuidedSetupIpc({
        ipc: ipcMain,
        window: () =>
          BrowserWindow.getAllWindows().find((window) =>
            window.webContents.getURL().endsWith("/guided-setup.html"),
          ) ?? null,
        engine,
        startup: { supported: () => false, enabled: () => false, set: () => undefined },
      });
      (globalThis as typeof globalThis & { guidedLifecycle?: unknown }).guidedLifecycle = {
        release: () => {
          healthy = true;
          release?.();
        },
        state: () => ({ raw, serviceRuns }),
      };
    }, GUIDED_SETUP_FIXTURE_REQUEST_CHANNELS);
    await setup.reload();
    const services = setup.locator(".guided-step").filter({ hasText: "Start Ardur services" });
    await setup.getByRole("button", { name: "Start setup" }).click();
    await expect(services).toHaveAttribute("data-status", "waiting-input");
    await services.getByRole("button", { name: "Continue setup" }).click();
    await expect(services).toHaveAttribute("data-status", "running");
    await setup.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(services).toContainText("Stopped");

    await setup.getByRole("button", { name: "Start setup" }).click();
    await expect(services).toHaveAttribute("data-status", "waiting-input");
    await services.getByRole("button", { name: "Continue setup" }).click();
    await expect(services).toHaveAttribute("data-status", "running");
    await desktop.evaluate(() => {
      const state = (globalThis as typeof globalThis & { guidedLifecycle: { release(): void } })
        .guidedLifecycle;
      state.release();
    });
    const engines = setup.locator(".guided-step").filter({ hasText: "Check optional computers" });
    await expect(engines).toHaveAttribute("data-status", "waiting-input");
    await engines.getByRole("button", { name: "Skip" }).click();
    const before = await desktop.evaluate(() =>
      (
        globalThis as typeof globalThis & {
          guidedLifecycle: { state(): { raw: string; serviceRuns: number } };
        }
      ).guidedLifecycle.state(),
    );
    await setup.evaluate(async () => {
      const guided = (
        window as Window & { ardurbotSetup?: { guidedSetup?: { start(): Promise<unknown> } } }
      ).ardurbotSetup?.guidedSetup;
      if (!guided) throw new Error("Guided setup bridge is unavailable.");
      await guided.start();
    });
    const after = await desktop.evaluate(() =>
      (
        globalThis as typeof globalThis & {
          guidedLifecycle: { state(): { raw: string; serviceRuns: number } };
        }
      ).guidedLifecycle.state(),
    );
    expect(after.serviceRuns).toBe(before.serviceRuns);
    expect(JSON.parse(after.raw).receipts.services).toEqual(
      JSON.parse(before.raw).receipts.services,
    );
    expect(await readFile(path.join(userData, "setup.json"), "utf8").catch(() => null)).toBeNull();
  } finally {
    await desktop.close();
    await rm(userData, { recursive: true, force: true });
  }
});
