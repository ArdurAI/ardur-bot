import {
  localImportFixture,
  localImportStatusFixture,
} from "@ardurbot/testkit/local-import-fixtures";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("owner previews, imports and removes local tool data", async ({ page }, testInfo) => {
  await signup(page, `import-${Date.now()}@ardurbot.test`, "password12", "Import fixture");
  await completeOnboarding(page);
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      json: { json: { ...body.json, me: { ...body.json.me, isDeploymentOwner: true } } },
    });
  });
  await page.goto("/app");
  let imported = false;
  const skill = localImportFixture.items[1]!;
  await page.route("**/rpc/localImport/**", async (route) => {
    const endpoint = new URL(route.request().url()).pathname.split("/").at(-1);
    const action = route.request().postDataJSON()?.json;
    if (action?.action === "import") imported = true;
    if (action?.action === "undo") imported = false;
    const json =
      endpoint === "status"
        ? {
            ...localImportStatusFixture,
            importedAt: imported ? "2026-09-24T12:00:00.000Z" : null,
            imported: imported ? [{ tool: "claude-code", count: 2 }] : [],
          }
        : action?.action === "preview"
          ? {
              preview: {
                item: localImportFixture.items[0],
                content: "Use the offline build command.",
              },
            }
          : {
              result: {
                created: action?.itemId ? 1 : imported ? 1 : 0,
                removed: imported ? 0 : 2,
                updated: 0,
                unchanged: 0,
                skipped: 0,
                conflicts: 0,
                failed: imported && !action?.itemId ? 1 : 0,
              },
              ...(imported && !action?.itemId
                ? {
                    failures: [
                      {
                        itemId: skill.id,
                        tool: skill.tool,
                        category: skill.category,
                        relativePath: skill.relativePath,
                        reason: "failed",
                      },
                    ],
                  }
                : {}),
            };
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ json }) });
  });
  await openUserSettings(page, "import");
  await expect(page.getByRole("heading", { name: "Found on this Mac" })).toBeVisible();
  await captureScreenshot(page, testInfo, "local-import-found");
  await page.getByText("Preview", { exact: true }).first().click();
  await page.getByRole("button", { name: "build.md", exact: true }).click();
  await expect(page.getByText("Use the offline build command.", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "local-import-preview");
  await page.getByRole("button", { name: "Import all", exact: true }).click();
  await expect(page.getByText("Auto-import changes", { exact: true })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Auto-import changes" })).not.toBeChecked();
  await expect(page.getByText("Could not be saved.", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "local-import-failed-item");
  await page.getByRole("button", { name: `Retry ${skill.relativePath}` }).click();
  await expect(
    page.getByText(
      "2 imported, 0 updated, 0 unchanged, 0 removed, 0 skipped, 0 conflicts, 0 failed.",
      {
        exact: true,
      },
    ),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "local-import-imported");
  await page.getByRole("button", { name: "Remove imported items from Claude Code" }).click();
  await expect(
    page.getByRole("button", { name: "Remove imported items from Claude Code" }),
  ).toHaveCount(0);
  await captureScreenshot(page, testInfo, "local-import-removed");
});
