import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("Computers shows host tools, a failed login profile and registered folders", async ({
  page,
}, testInfo) => {
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
  await signup(page, `host-${Date.now()}@example.test`, "fixture-password-123", "Test operator");
  await completeOnboarding(page);
  await openUserSettings(page);
  await page.getByRole("button", { name: "Computers", exact: true }).click();
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
