import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("Computers shows fleet capacity, placement and move consent", async ({ page }, testInfo) => {
  await signup(page, `fleet-${Date.now()}@ardurbot.test`, "password12", "Builder");
  await completeOnboarding(page);
  const capacity = {
    cpuCount: 8,
    cpuLoad1m: 0.5,
    memoryTotal: 32 * 1024 ** 3,
    memoryFree: 24 * 1024 ** 3,
    diskFree: 100 * 1024 ** 3,
    sampledAt: new Date().toISOString(),
    source: "ssh",
  };
  const targets = [
    {
      id: "host",
      name: "This Mac",
      kind: "host",
      connectionId: null,
      state: "connected",
      capacity: { ...capacity, memoryFree: 1.2 * 1024 ** 3, source: "host" },
      bots: [{ id: "builder", name: "Builder" }],
    },
    {
      id: "remote",
      name: "Linux computer",
      kind: "ssh",
      connectionId: "remote",
      state: "connected",
      capacity,
      bots: [],
    },
  ];
  await page.route("**/rpc/fleet/list", (route) =>
    route.fulfill({
      json: {
        json: {
          targets,
          placement: { mode: "free-memory", preferredTargetId: "host", minimumFreeGb: 4 },
          bots: [
            {
              id: "builder",
              name: "Builder",
              moveAutomatically: false,
              pending: {
                targetId: "remote",
                connectionId: "remote",
                fromTargetId: "host",
                reason: "it had the most free memory",
                decidedAt: new Date().toISOString(),
              },
            },
          ],
        },
      },
    }),
  );
  await page.route("**/rpc/fleet/discover", (route) => route.fulfill({ json: { json: [] } }));
  const settings = await openUserSettings(page);
  await settings.getByRole("button", { name: "Computers", exact: true }).click();
  const fleet = page.getByTestId("fleet-settings");
  await expect(fleet).toContainText("24.0 GB free");
  await expect(fleet.getByLabel("Placement", { exact: true })).toHaveValue("free-memory");
  await expect(fleet.getByRole("button", { name: "Move", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "fleet-placement");
});
