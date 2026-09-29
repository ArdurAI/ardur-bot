import { expect, type Page, type TestInfo } from "@playwright/test";
import { DEPLOYMENT_OWNER_RENEW_MS } from "../../../packages/testkit/src/cli/deployment-owner.js";

export function isRealSandboxProvider(provider = process.env.SANDBOX_PROVIDER) {
  return provider === "e2b" || provider === "daytona" || provider === "box";
}

export function realSandboxTimeout(real: number, emulated: number) {
  if (process.env.SANDBOX_PROVIDER === "box") return Math.max(real, 300_000);
  return isRealSandboxProvider() ? real : emulated;
}

export function activeBotId(page: Page) {
  const id = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1);
  if (!id || id === "app" || id === "bots") throw new Error(`missing bot id in ${page.url()}`);
  return id;
}

export async function rpc<T>(page: Page, procedure: string, body: unknown): Promise<T> {
  const response = await page.request.post(`/rpc/${procedure}`, { data: { json: body } });
  const parsed = (await response.json()) as { json?: T; error?: { message?: string } };
  if (!response.ok() || parsed.error) {
    throw new Error(`${procedure} ${response.status()}: ${parsed.error?.message ?? "failed"}`);
  }
  return parsed.json as T;
}

export async function claimDeploymentOwner(page: Page): Promise<() => Promise<void>> {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) throw new Error("The e2e API URL is missing");
  const ownerUrl = `${apiUrl}/__e2e/deployment-owner`;
  for (;;) {
    const response = await page.request.post(ownerUrl, {
      timeout: 125_000,
    });
    if (response.status() === 423) continue;
    if (!response.ok()) throw new Error(`Cannot set up deployment owner: ${response.status()}`);
    break;
  }
  let renewal: Promise<void> | undefined;
  let renewalError: unknown;
  const timer = setInterval(() => {
    if (renewal) return;
    renewal = page.request
      .post(ownerUrl)
      .then((response) => {
        if (!response.ok()) throw new Error(`Cannot renew deployment owner: ${response.status()}`);
        renewalError = undefined;
      })
      .catch((error: unknown) => {
        renewalError = error;
      })
      .finally(() => {
        renewal = undefined;
      });
  }, DEPLOYMENT_OWNER_RENEW_MS);
  return async () => {
    clearInterval(timer);
    await renewal;
    const release = await page.request.delete(ownerUrl);
    if (!release.ok()) throw new Error(`Cannot release deployment owner: ${release.status()}`);
    if (renewalError) throw renewalError;
  };
}

export async function completeOnboarding(
  page: Page,
  testInfo?: TestInfo,
  navigationTimeout = 20_000,
) {
  await page.waitForURL(/\/(onboarding|app)/, {
    timeout: navigationTimeout,
    waitUntil: "domcontentloaded",
  });
  // Optional Server integrations step (needsSetup). Skip when shown, then the
  // first bot is created automatically — land in Chief's chat with no form.
  const integrations = page.getByRole("heading", { name: "Server integrations", exact: true });
  const chief = page.getByText("Chief").first();
  await integrations
    .or(chief)
    .or(page.getByText("Opening chat…"))
    .waitFor({ timeout: navigationTimeout });
  if ((await chief.isVisible().catch(() => false)) && page.url().includes("/app")) {
    if (testInfo) {
      await captureScreenshot(page, testInfo, "03-create-first-bot");
      await captureScreenshot(page, testInfo, "06-onboarding-complete");
    }
    return;
  }
  if (await integrations.isVisible().catch(() => false)) {
    if (testInfo) await captureScreenshot(page, testInfo, "02-connect-apps");
    await page.getByRole("button", { name: "Skip", exact: true }).click();
  }
  await page.waitForURL(/\/app\//, {
    timeout: navigationTimeout,
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByText("Chief").first()).toBeVisible();
  if (testInfo) {
    await captureScreenshot(page, testInfo, "03-create-first-bot");
    await captureScreenshot(page, testInfo, "06-onboarding-complete");
  }
}

export async function signup(
  page: Page,
  email: string,
  password: string,
  name: string,
  testInfo?: TestInfo,
) {
  await page.goto("/sign-up");
  await expect(page.getByRole("heading", { name: "Create your Ardur" })).toBeVisible();
  if (testInfo) await captureScreenshot(page, testInfo, "01-sign-up");
  await page.getByPlaceholder("Your name").fill(name);
  await page.getByPlaceholder("Your email address").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
}

export async function captureScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const screenshotPath = testInfo.outputPath(`${name}.png`);
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    fullPage: true,
    path: screenshotPath,
  });
  await testInfo.attach(name, { contentType: "image/png", path: screenshotPath });
}

export async function openNewBot(page: Page) {
  await page.getByTestId("create-menu-trigger").click();
  await page.getByTestId("create-new-bot").click();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "create");
  await expect(page.getByTestId("create-bot-form")).toBeVisible();
}

export async function openNewGroup(page: Page) {
  await page.getByTestId("create-menu-trigger").click();
  await page.getByTestId("create-new-group").click();
}

export async function openNewSpace(page: Page) {
  await page.getByTestId("create-menu-trigger").click();
  await page.getByTestId("create-new-space").click();
}

/** Open the create form from the + picker, submit, and wait for the new chat. */
export async function createBotFromPicker(
  page: Page,
  options: {
    name?: string;
    title?: string;
    description?: string;
    computerMode?: "team" | "dedicated";
  } = {},
) {
  const name = options.name ?? "New Bot";
  await openNewBot(page);
  const form = page.getByTestId("create-bot-form");
  await form.locator("label:has-text('Name') input").fill(name);
  if (options.title != null) {
    await form.locator("label:has-text('Title') input").fill(options.title);
  }
  if (options.description != null) {
    await form.locator("label:has-text('Description') textarea").fill(options.description);
  }
  if (options.computerMode === "dedicated") {
    await form.getByTestId("create-bot-private").click();
  } else if (options.computerMode === "team") {
    await form.getByTestId("create-bot-team").click();
  }
  await form.getByRole("button", { name: "Create", exact: true }).click();
  await page.waitForURL(/\/app\/[^/]+$/);
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "closed");
}

/** Open Settings from the global header, optionally switching to a section. */
export async function openUserSettings(
  page: Page,
  section?:
    | "general"
    | "account"
    | "privacy"
    | "models"
    | "memory"
    | "import"
    | "voice"
    | "usage"
    | "integrations"
    | "computer"
    | "boards"
    | "updates",
) {
  await page
    .locator("header.app-drag")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  if (section && section !== "general") {
    await settings.getByTestId(`settings-nav-${section}`).click();
  }
  return settings;
}

/** Create a named bot via RPC for test setup (skips the + picker). */
export async function createNamedBot(
  page: Page,
  name: string,
  options: { computerMode?: "team" | "dedicated" } = {},
) {
  const bot = await rpc<{ id: string; name: string }>(page, "bots/create", {
    name,
    title: "",
    description: "",
    notifyOnFinish: true,
    computerMode: options.computerMode ?? "team",
  });
  await page.goto(`/app/${bot.id}`);
  await expect(page.getByPlaceholder(`Message ${name}`)).toBeVisible();
  return bot.id;
}
