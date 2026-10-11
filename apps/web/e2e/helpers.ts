import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import {
  DEPLOYMENT_OWNER_CLAIM_DEADLINE_MS,
  DEPLOYMENT_OWNER_RENEW_MS,
} from "../../../packages/testkit/src/cli/deployment-owner.js";
import {
  finishSetup,
  SETUP_ERROR_ACCOUNT,
  SETUP_ERROR_MODELS,
  type SetupError,
  type SetupObservation,
} from "./setup-completion.js";

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
  const text = await response.text();
  let parsed: { json?: T; error?: { message?: string } };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `${procedure} ${response.status()}: expected JSON, received ${JSON.stringify(text.slice(0, 200))}`,
    );
  }
  if (!response.ok() || parsed.error) {
    throw new Error(`${procedure} ${response.status()}: ${parsed.error?.message ?? "failed"}`);
  }
  return parsed.json as T;
}

export async function claimDeploymentOwner(page: Page): Promise<() => Promise<void>> {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) throw new Error("The e2e API URL is missing");
  const ownerUrl = `${apiUrl}/__e2e/deployment-owner`;
  const startedAt = Date.now();
  let lastStatus = 0;
  for (;;) {
    if (Date.now() - startedAt >= DEPLOYMENT_OWNER_CLAIM_DEADLINE_MS) {
      const status = lastStatus || "none";
      throw new Error(
        `Timed out waiting for the deployment owner after ${DEPLOYMENT_OWNER_CLAIM_DEADLINE_MS}ms (last status ${status})`,
      );
    }
    const response = await page.request.post(ownerUrl, {
      timeout: 125_000,
    });
    lastStatus = response.status();
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

const CHAT_COMPOSER_NAME = /^Message /;
const signupCredentials = new WeakMap<Page, { email: string; password: string }>();

function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function leftSignUp(url: string): boolean {
  const pathname = pathnameOf(url);
  return pathname === "/onboarding" || pathname.startsWith("/app");
}

async function visibleSetupError(page: Page): Promise<SetupError | null> {
  for (const message of [SETUP_ERROR_ACCOUNT, SETUP_ERROR_MODELS]) {
    if (
      await page
        .getByRole("alert")
        .filter({ hasText: message })
        .isVisible()
        .catch(() => false)
    ) {
      return message;
    }
  }
  return null;
}

async function observeSetup(page: Page): Promise<SetupObservation> {
  const composer = page.getByRole("combobox", { name: CHAT_COMPOSER_NAME });
  const composerVisible = await composer.isVisible().catch(() => false);
  return {
    url: page.url(),
    composerVisible,
    composerEnabled: composerVisible && (await composer.isEnabled().catch(() => false)),
    modelHeading: await page
      .getByRole("heading", { name: "Connect a model", exact: true })
      .isVisible()
      .catch(() => false),
    integrationsHeading: await page
      .getByRole("heading", { name: "Server integrations", exact: true })
      .isVisible()
      .catch(() => false),
    setupError: await visibleSetupError(page),
    existingAccount: await page
      .getByRole("alert")
      .filter({ hasText: /already exists/i })
      .isVisible()
      .catch(() => false),
    signInHeading: await page
      .getByRole("heading", { name: "Sign in to Ardur", exact: true })
      .isVisible()
      .catch(() => false),
    openingChat: await page
      .getByText("Opening chat…", { exact: true })
      .isVisible()
      .catch(() => false),
  };
}

async function waitForSetupChange(
  page: Page,
  remainingMs: number,
  observation: SetupObservation,
): Promise<void> {
  const composer = page.getByRole("combobox", { name: CHAT_COMPOSER_NAME });
  if (observation.composerVisible && !observation.composerEnabled) {
    await expect(composer)
      .toBeEnabled({ timeout: remainingMs })
      .catch(() => undefined);
    return;
  }
  if (observation.setupError) {
    await page
      .getByRole("alert")
      .filter({ hasText: observation.setupError })
      .waitFor({ state: "hidden", timeout: remainingMs })
      .catch(() => undefined);
    return;
  }
  if (observation.existingAccount) {
    await page
      .getByRole("alert")
      .filter({ hasText: /already exists/i })
      .waitFor({ state: "hidden", timeout: remainingMs })
      .catch(() => undefined);
    return;
  }
  if (observation.integrationsHeading) {
    await page
      .getByRole("heading", { name: "Server integrations", exact: true })
      .waitFor({ state: "hidden", timeout: remainingMs })
      .catch(() => undefined);
    return;
  }
  if (observation.signInHeading) {
    await page
      .getByRole("heading", { name: "Sign in to Ardur", exact: true })
      .waitFor({ state: "hidden", timeout: remainingMs })
      .catch(() => undefined);
    return;
  }
  // Opening chat is not a signal. Wait for a heading, an alert, or the composer.
  await composer
    .or(page.getByRole("heading", { name: "Connect a model", exact: true }))
    .or(page.getByRole("heading", { name: "Server integrations", exact: true }))
    .or(page.getByRole("alert"))
    .first()
    .waitFor({ timeout: remainingMs })
    .catch(() => undefined);
}

async function signInExistingAccount(page: Page, email: string, password: string, timeout: number) {
  await page.goto(`/sign-in?next=${encodeURIComponent("/onboarding")}`);
  await page.getByRole("heading", { name: "Sign in to Ardur", exact: true }).waitFor({ timeout });
  await page.getByPlaceholder("Your email address").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: "Continue with email" }).click();
  try {
    await page.waitForURL(/\/(onboarding|app)/, { timeout });
  } catch {
    throw new Error("Could not sign in to the existing account");
  }
}

export async function completeOnboarding(
  page: Page,
  testInfo?: TestInfo,
  navigationTimeout = 20_000,
) {
  const existingAccount = page.getByRole("alert").filter({ hasText: /already exists/i });
  await expect(async () => {
    if (await existingAccount.isVisible()) return;
    if (leftSignUp(page.url())) return;
    throw new Error(`Waiting to leave sign-up (${page.url()})`);
  }).toPass({ intervals: [100, 250, 500], timeout: navigationTimeout });
  if (await existingAccount.isVisible()) {
    const credentials = signupCredentials.get(page);
    if (!credentials) {
      throw new Error(
        "Setup is on an existing account. Sign in before the chat composer can become usable.",
      );
    }
    await signInExistingAccount(page, credentials.email, credentials.password, navigationTimeout);
  }
  let capturedIntegrations = false;
  await finishSetup({
    now: () => Date.now(),
    deadlineAt: Date.now() + navigationTimeout,
    deadlineMs: navigationTimeout,
    observe: () => observeSetup(page),
    skipIntegrations: async () => {
      if (testInfo && !capturedIntegrations) {
        await captureScreenshot(page, testInfo, "02-connect-apps");
        capturedIntegrations = true;
      }
      await page.getByRole("button", { name: "Skip", exact: true }).click();
    },
    retrySetup: async () => {
      await page.getByRole("button", { name: "Retry", exact: true }).click();
    },
    signInExisting: async () => {
      const credentials = signupCredentials.get(page);
      if (!credentials) {
        throw new Error(
          "Setup is on an existing account. Sign in before the chat composer can become usable.",
        );
      }
      await signInExistingAccount(page, credentials.email, credentials.password, navigationTimeout);
    },
    waitForChange: (remainingMs, observation) => waitForSetupChange(page, remainingMs, observation),
  });
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
  signupCredentials.set(page, { email, password });
  await page.goto("/sign-up");
  const createHeading = page.getByRole("heading", { name: "Create your Ardur" });
  await expect(async () => {
    if (await createHeading.isVisible()) return;
    if (leftSignUp(page.url())) return;
    throw new Error(`Waiting for Create your Ardur or an existing session (${page.url()})`);
  }).toPass({ intervals: [100, 250, 500], timeout: 20_000 });
  if (!(await createHeading.isVisible())) return;
  if (testInfo) await captureScreenshot(page, testInfo, "01-sign-up");
  await page.getByPlaceholder("Your name").fill(name);
  await page.getByPlaceholder("Your email address").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
}

/** Visible text stays inside the dialog, including on a narrow window. */
export async function expectVisibleTextInside(scope: Locator) {
  const box = await scope.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  const nodes = scope.locator("p, h2, h3, h4");
  const count = await nodes.count();
  for (let index = 0; index < count; index += 1) {
    const node = nodes.nth(index);
    if (!(await node.isVisible())) continue;
    const rect = await node.boundingBox();
    if (!rect) continue;
    expect(rect.x + rect.width).toBeLessThanOrEqual(box.x + box.width + 1);
  }
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

export async function openBotSettings(page: Page) {
  if ((await page.getByTestId("side-panel").getAttribute("data-panel")) !== "settings") {
    await page.getByRole("button", { name: "Views", exact: true }).click();
    await page.getByRole("menuitemcheckbox", { name: "Bot settings", exact: true }).click();
  }
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "settings");
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
  } else {
    // Live test deployments use the fake engine, not an isolated container.
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
