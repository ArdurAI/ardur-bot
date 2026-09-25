import { DEFAULT_USER_PREFERENCES, LOCAL_SETTINGS_PAGE } from "@ardurbot/contracts";
import { expect, test } from "@playwright/test";
import { accountFixture } from "./account-fixtures";

const longModel = `local-model-${"long-model-id-".repeat(16)}`;

test.beforeEach(async ({ page }) => {
  await page.route("**/api/auth/**", (route) => route.fulfill({ json: null }));
  await page.route("**/rpc/**", (route) => {
    const procedure = new URL(route.request().url()).pathname.slice(5);
    const responses: Record<string, unknown> = {
      "preferences/get": DEFAULT_USER_PREFERENCES,
      "notifications/capabilities": { dispatchPush: false },
      "delegations/policy": { mode: "any" },
      "host/status": { roots: [] },
      "account/get": accountFixture,
      "account/localDevices": [],
      "account/sessions": [],
      "updater/status": { installKind: "source" },
      "approvalRules/list": [],
      "autoReview/get": { enabled: false, checkerAvailable: false },
      "bots/list": [],
      "models/list": [
        ...Array.from({ length: 30 }, (_, index) => ({
          id: `model-${index}`,
          label: `Model ${index}`,
          provider: `provider-${index}`,
          providerName: `Provider ${index}`,
          auth: "api-key",
          billing: "API",
        })),
        {
          id: longModel,
          label: longModel,
          provider: "openai-compatible",
          providerName: "OpenAI-compatible",
          auth: "api-key",
          billing: "local",
          source: "custom",
        },
      ],
      "models/credentials": [
        {
          id: "connection",
          provider: "openai-compatible",
          modelId: longModel,
          baseUrl: "http://127.0.0.1:59999/v1",
          hasKey: true,
          isDefault: true,
        },
      ],
      me: { defaultProvider: "openai-compatible", defaultModel: longModel },
    };
    if (!(procedure in responses)) throw new Error(`Unexpected RPC: ${procedure}`);
    return route.fulfill({ json: { json: responses[procedure] } });
  });
  await page.route("**/qa-verification**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true; await import("/src/pages/account/account-preview.tsx");</script></body></html>',
    }),
  );
});

test("Settings finds Password before Account mounts and focuses its row", async ({ page }) => {
  await page.goto("/qa-verification?general");
  await page.getByRole("searchbox", { name: "Search settings" }).fill("password");
  await page.getByTestId("settings-nav-account").click();
  await expect(page.getByLabel("Current password", { exact: true })).toBeFocused();
});

test("source web hides Updates, including for the owner", async ({ page }) => {
  await page.goto("/qa-verification?owner");
  await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
  await expect(page.getByTestId("settings-nav-updates")).toHaveCount(0);
});

test("unknown routes offer a working return link, including after reload", async ({ page }) => {
  await page.goto("/qa-missing-page");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("link", { name: "Back to home" })).toHaveAttribute("href", "/");
  await page.getByRole("link", { name: "Back to home" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: "Page not found" })).toHaveCount(0);
});

test("Delete keeps an HTML-like routine name as literal text without translation errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const name = '<b>weekly</b> & <script>alert("test")</script>';
  await page.goto(`/qa-verification?delete=${encodeURIComponent(name)}`);
  await expect(page.getByRole("heading", { name: `Delete ${name}?`, exact: true })).toBeVisible();
  await expect(page.getByRole("heading").locator("b, script")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("local settings explains the missing desktop bridge", async ({ page }) => {
  await page.goto(LOCAL_SETTINGS_PAGE);
  await expect(page.getByRole("alert")).toHaveText(
    "Open local settings from the desktop app on the server’s computer.",
  );
  await expect(page.getByRole("alert")).not.toContainText("create its owner account");
});

test("General and Account describe the same approval policy", async ({ page }) => {
  const policy =
    "Actions usually run automatically. Rules, safety checks, and integration policies may require confirmation.";
  await page.goto("/qa-verification?general&owner");
  await expect(page.getByRole("group", { name: "Trusted folders" })).toContainText(policy);
  await page.getByTestId("settings-nav-account").click();
  await page.getByText("Action confirmations", { exact: true }).click();
  await expect(page.getByTestId("advanced-settings")).toContainText(policy);
});

test("Account navigation uses link semantics without Base UI warnings", async ({ page }) => {
  const warnings: string[] = [];
  page.on("console", (message) => {
    if (/Base UI.*button/i.test(message.text())) warnings.push(message.text());
  });
  await page.goto("/qa-verification?owner");
  const link = page.getByRole("link", { name: "Manage", exact: true });
  await expect(link).toHaveAttribute("href", "/integrations/setup");
  await link.focus();
  await expect(link).toBeFocused();
  expect(warnings).toEqual([]);
});

for (const width of [375, 768]) {
  test(`Models fields remain reachable at ${width}px with large text and long model ids`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 812 });
    await page.goto("/qa-verification");
    await page.getByTestId("settings-nav-models").click();
    await page.addStyleTag({
      content: "html { font-size: 20px; } input, label, button, p { font-size: 20px !important; }",
    });
    const url = page.getByLabel("OpenAI-compatible server URL");
    await expect(url).toHaveValue("http://127.0.0.1:59999/v1");
    expect(
      await url.evaluate((element) => {
        for (let node = element.parentElement; node; node = node.parentElement) {
          if (getComputedStyle(node).overflowY !== "visible" && node.clientHeight === 0)
            return false;
        }
        return true;
      }),
    ).toBe(true);
    await url.scrollIntoViewIfNeeded({ timeout: 5000 });
    await url.fill("http://127.0.0.1:59999/v2", { timeout: 5000 });
    const bounds = await url.boundingBox();
    expect(bounds!.width).toBeGreaterThan(240);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(812);
    await page.getByLabel("Model id", { exact: true }).fill(longModel);
    await page.getByRole("button", { name: "Save", exact: true }).scrollIntoViewIfNeeded();
    const panel = page.getByTestId("user-settings");
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath(`models-${width}.png`) });
  });
}
