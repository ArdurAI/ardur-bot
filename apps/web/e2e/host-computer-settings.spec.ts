import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";
import { installPerformanceFixture } from "./performance-fixture";

test("Computers shows host tools, a failed login profile and registered folders", async ({
  page,
}, testInfo) => {
  await installPerformanceFixture(page);
  await page.route("**/rpc/host/status", (route) =>
    route.fulfill({
      json: {
        json: {
          configured: true,
          connected: true,
          roots: ["/fixture/projects"],
          health: {
            platform: "darwin",
            roots: ["/fixture/projects"],
            load: 0,
            environment: {
              tools: [
                { name: "gh", version: "2.80.0", status: "signed in" },
                { name: "kubectl", status: "not checked" },
                { name: "docker", status: "not checked" },
              ],
              diagnostic:
                "Your login shell profile failed to load (zsh, exit 1); commands run with a default PATH",
            },
            claude: { runtimeKind: "claude-code", available: true, version: "2.1.259", models: [] },
            codex: {
              runtimeKind: "codex-app-server",
              available: true,
              version: "0.156.1",
              models: [],
            },
          },
        },
      },
    }),
  );
  await page.route("**/rpc/fleet/list", (route) =>
    route.fulfill({
      json: {
        json: {
          targets: [],
          placement: { mode: "free-memory", preferredTargetId: null, minimumFreeGb: 4 },
          bots: [],
        },
      },
    }),
  );
  await page.route("**/rpc/fleet/discover", (route) => route.fulfill({ json: { json: [] } }));
  await page.goto("/app");
  await page.getByRole("banner").getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByTestId("settings-nav-computer").click();
  await page
    .getByTestId("computers-setup-settings")
    .getByText("This computer", { exact: true })
    .click();
  await expect(page.getByTestId("host-computer-settings")).toContainText(
    "Connected · claude 2.1.259 · codex 0.156.1",
  );
  await expect(page.getByTestId("host-computer-settings")).toContainText("/fixture/projects");
  await expect(page.getByTestId("host-computer-settings")).toContainText(
    "Tools: gh, kubectl, docker",
  );
  await expect(page.getByTestId("host-computer-settings")).toContainText(
    "Your login shell profile failed to load (zsh, exit 1)",
  );
  await captureScreenshot(page, testInfo, "host-computer-settings");
});

test("Computers in local mode shows this computer's capacity and the folders this app added", async ({
  page,
}, testInfo) => {
  await installPerformanceFixture(page);
  await page.route("**/rpc/host/status", (route) =>
    route.fulfill({
      json: {
        json: {
          configured: false,
          connected: true,
          roots: ["/fixture/projects", "/fixture/archive"],
          health: {
            platform: "darwin",
            roots: ["/fixture/projects", "/fixture/archive"],
            load: 0,
            capacity: {
              cpuCount: 8,
              cpuLoad1m: 1.5,
              memoryTotal: 16 * 1024 ** 3,
              memoryFree: 6 * 1024 ** 3,
              diskFree: 200 * 1024 ** 3,
              sampledAt: new Date().toISOString(),
              source: "host",
            },
            environment: { tools: [{ name: "gh", status: "not checked" }], diagnostic: "" },
            claude: { runtimeKind: "claude-code", available: false, models: [] },
            codex: { runtimeKind: "codex-app-server", available: false, models: [] },
          },
        },
      },
    }),
  );
  await page.route("**/rpc/fleet/list", (route) =>
    route.fulfill({
      json: {
        json: {
          targets: [],
          placement: { mode: "free-memory", preferredTargetId: null, minimumFreeGb: 4 },
          bots: [],
        },
      },
    }),
  );
  await page.route("**/rpc/fleet/discover", (route) => route.fulfill({ json: { json: [] } }));
  await page.addInitScript(() => {
    Object.defineProperty(window, "ardurbotDesktop", {
      value: {
        platform: "darwin",
        oauth: { onCallback: () => () => {} },
        window: {
          close: async () => {},
          minimize: async () => {},
          toggleMaximize: async () => {},
          state: async () => ({}),
        },
        // Local mode: this app keeps the list, and one folder is on a drive that is not plugged in.
        host: {
          state: async () => ({
            configured: false,
            local: true,
            roots: ["/fixture/projects", "/fixture/archive"],
            unavailable: ["/fixture/archive"],
          }),
          setup: async () => {},
          addRoot: async () => null,
          removeRoot: async () => {},
          clear: async () => {},
        },
      },
    });
  });
  await page.goto("/app");
  await page.getByRole("banner").getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByTestId("settings-nav-computer").click();
  await page
    .getByTestId("computers-setup-settings")
    .getByText("This computer", { exact: true })
    .click();
  const host = page.getByTestId("host-computer-settings");
  await expect(host).toContainText("6.0 GB free · 8 CPU · Load 1.5 · Disk 200.0 GB");
  await expect(host).not.toContainText("Host service");
  await expect(host.getByRole("button", { name: "Set up", exact: true })).toHaveCount(0);
  await expect(
    host.getByRole("button", { name: "Disconnect this computer", exact: true }),
  ).toHaveCount(0);
  await expect(
    host.getByRole("button", { name: "Add folder", exact: true }),
  ).toHaveAccessibleDescription(
    "Local access lets bots run commands without asking. Avoid it on shared or public servers.",
  );
  await expect(host.getByRole("listitem")).toHaveCount(2);
  await expect(host.getByRole("listitem").nth(1)).toContainText("This folder is not available.");
  await expect(host.getByRole("listitem").nth(0)).not.toContainText("not available");
  await expect(host.getByRole("button", { name: "Add folder", exact: true })).toBeVisible();
  await expect(host.getByRole("button", { name: "Remove", exact: true })).toHaveCount(2);
  await host.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "host-computer-settings-local-mode");
});
