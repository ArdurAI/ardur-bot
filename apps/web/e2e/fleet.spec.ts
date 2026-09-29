import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("Computers shows fleet capacity, placement and move consent", async ({ page }, testInfo) => {
  await page.route("**/rpc/bootstrap", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { json: { ...body.json, me: { ...body.json.me, isDeploymentOwner: true } } },
    });
  });
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
      id: "refused-engine",
      name: "Docker Desktop on this Mac",
      kind: "docker",
      connectionId: "refused-engine",
      state: "unavailable",
      endpoint: "unix:///fixture/refused.sock",
      reachability: {
        status: "installed-not-running",
        reason: "engine-not-running",
        checkedAt: new Date().toISOString(),
      },
      capacity: { ...capacity, memoryFree: null, memoryTotal: null, source: "not-reported" },
      bots: [],
    },
    {
      id: "remote",
      name: "Linux computer",
      kind: "ssh",
      connectionId: "remote",
      state: "connected",
      ssh: {
        host: "fixture.example.invalid",
        user: "runner",
        port: 22,
        authentication: "agent",
        baseDirectory: "~/.ardurbot/computers",
      },
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
  await page.route("**/rpc/fleet/test", (route) =>
    route.fulfill({
      json: {
        json: {
          ok: false,
          reason: "engine-not-running",
          checkedAt: new Date().toISOString(),
          targets: [targets[1]],
        },
      },
    }),
  );
  await page.route("**/rpc/fleet/details", (route) =>
    route.fulfill({
      json: {
        json: {
          id: "remote",
          name: targets[2]!.name,
          settings: {
            engine: "ssh",
            ssh: targets[2]!.ssh,
            namespace: "ardurbot",
            storageSize: "10Gi",
            cpuRequest: "250m",
            cpuLimit: "2",
            memoryRequest: "256Mi",
            memoryLimit: "2Gi",
          },
          hasCredential: false,
          activeRuns: false,
        },
      },
    }),
  );
  await page.route("**/rpc/fleet/update", async (route) => {
    const request = route.request().postDataJSON() as { json: { connection: { name: string } } };
    targets[2]!.name = request.json.connection.name;
    await route.fulfill({
      json: { json: { ok: true, checkedAt: new Date().toISOString(), targets: [targets[2]] } },
    });
  });
  await page.route("**/rpc/fleet/remove", async (route) => {
    targets.splice(2, 1);
    await route.fulfill({ json: { json: { ok: true } } });
  });
  const discovered = [
    {
      id: "discovered-docker",
      name: "Docker Desktop on this Mac",
      kind: "docker",
      connectionId: null,
      state: "discovered",
      reachability: {
        status: "installed-not-running",
        reason: "engine-not-running",
        checkedAt: new Date().toISOString(),
      },
      endpoint: "/var/run/docker.sock",
      capacity: {
        cpuCount: null,
        cpuLoad1m: null,
        memoryTotal: null,
        memoryFree: null,
        diskFree: null,
        sampledAt: null,
        source: "unknown",
      },
      bots: [],
    },
  ];
  await page.route("**/rpc/fleet/discover", (route) =>
    route.fulfill({ json: { json: discovered } }),
  );
  const settings = await openUserSettings(page);
  await settings.getByRole("button", { name: "Computers", exact: true }).click();
  const fleet = page.getByTestId("fleet-settings");
  await expect(fleet).toContainText("24.0 GB free");
  await expect(fleet.getByLabel("Placement", { exact: true })).toHaveValue("free-memory");
  await expect(fleet.getByRole("button", { name: "Move", exact: true })).toBeVisible();
  const refusedRow = fleet.locator('[data-fleet-target="refused-engine"]');
  await expect(refusedRow).toContainText("Installed, not running · Engine not running");
  await expect(refusedRow).not.toContainText("Memory not reported");
  await refusedRow.getByRole("button", { name: "Test" }).click();
  await expect(refusedRow).toContainText("Engine not running");
  await captureScreenshot(page, testInfo, "fleet-placement");

  const discoveredRow = fleet.locator('[data-fleet-target="discovered-docker"]');
  await discoveredRow.getByRole("button", { name: "Add", exact: true }).click();

  const addDialog = page.getByRole("dialog", { name: "Add computer" });
  await expect(addDialog).toBeVisible();
  await expect(addDialog.getByLabel("Connection type")).toHaveValue("docker");
  await expect(addDialog.getByLabel("Name")).toHaveValue("Docker Desktop on this Mac");
  await expect(addDialog.getByLabel("Engine endpoint")).toHaveValue("/var/run/docker.sock");
  await captureScreenshot(page, testInfo, "fleet-add-dialog");

  await addDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(addDialog).not.toBeVisible();

  const remoteRow = fleet.locator('[data-fleet-target="remote"]');
  await remoteRow.getByRole("button", { name: "Edit" }).click();
  const editDialog = page.getByRole("dialog", { name: "Edit computer" });
  await expect(editDialog.getByLabel("Name")).toHaveValue("Linux computer");
  await editDialog.getByLabel("Name").fill("Workshop computer");
  await editDialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(remoteRow).toContainText("Workshop computer");
  await captureScreenshot(page, testInfo, "fleet-edited-target");
  await remoteRow.getByRole("button", { name: "Remove" }).click();
  const removeDialog = page.getByRole("dialog", { name: "Remove computer" });
  await expect(removeDialog).toContainText("Past run history remains.");
  await removeDialog.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(remoteRow).toHaveCount(0);
  await captureScreenshot(page, testInfo, "fleet-removed-target");

  await fleet.getByRole("button", { name: "Add computer", exact: true }).click();
  await expect(addDialog).toBeVisible();
  await expect(addDialog.getByLabel("Name")).toHaveValue("");
  await addDialog.getByLabel("Connection type").selectOption("kubernetes");
  await addDialog.getByText("Advanced", { exact: true }).click();
  await expect(addDialog.getByLabel("Standard image")).toBeVisible();
  await expect(addDialog.getByLabel("Developer image")).toBeVisible();
  await expect(addDialog.getByLabel("Image pull secret")).toBeVisible();
  await captureScreenshot(page, testInfo, "fleet-kubernetes-images");
  await addDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(addDialog).not.toBeVisible();
});
