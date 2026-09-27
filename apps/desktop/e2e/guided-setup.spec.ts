import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("flagged setup opens the local guided document before any local work", async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "ardur-guided-e2e-"));
  const env = {
    ...process.env,
    ARDURBOT_PERFORMANCE_USER_DATA: userData,
    ARDURBOT_GUIDED_SETUP: "1",
  };
  delete env.ARDURBOT_WEB_URL;
  const executablePath = process.env.ARDURBOT_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath: path.resolve(executablePath) } : {}),
    args: executablePath ? [] : ["."],
    cwd: path.resolve(import.meta.dirname, ".."),
    env,
  });
  try {
    const setup = await app.firstWindow();
    await expect(setup.getByRole("heading", { name: "Set up Ardur" })).toBeVisible();
    await expect(setup.getByRole("radio", { name: "This computer" })).toBeChecked();
    await expect(setup.locator(".guided-step")).toHaveCount(9);
    await expect(setup.getByRole("button", { name: "Start setup" })).toBeVisible();
    await mkdir(path.join(import.meta.dirname, "screenshots"), { recursive: true });
    await setup.screenshot({
      path: path.join(import.meta.dirname, "screenshots", "guided-setup-desktop.png"),
    });
    await setup.getByRole("radio", { name: "Connect to a server" }).check();
    await expect(setup.getByLabel("Server address")).toBeVisible();
    await expect(setup.locator(".guided-step")).toHaveCount(0);
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});
