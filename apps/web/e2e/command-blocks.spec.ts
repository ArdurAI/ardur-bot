import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("rerun remains disabled when current access cannot be checked", async ({ page }) => {
  let deny: (() => void) | undefined;
  await page.route("**/rpc/commands/open", async (route) => {
    await new Promise<void>((resolve) => {
      deny = resolve;
    });
    await route.fulfill({ status: 403, json: { code: "FORBIDDEN", message: "Unavailable" } });
  });
  await page.goto("/e2e/fixtures/command-blocks.html");
  const block = page.getByTestId("command-block").first();
  await block.getByRole("button", { name: /Ran/ }).click();
  await expect(block.getByRole("button", { name: "Rerun", exact: true })).toBeDisabled();
  await expect.poll(() => typeof deny).toBe("function");
  deny!();
  await expect(
    block.getByText("Rerun is unavailable; reopen this block to check again."),
  ).toBeVisible();
  await expect(block.getByRole("button", { name: "Rerun", exact: true })).toBeDisabled();
});

test("command blocks fold, show inert output, search a run and export a log", async ({
  page,
}, testInfo) => {
  await page.route("**/rpc/commands/**", async (route) => {
    expect(route.request().headers()["x-ardurbot-space-id"]).toBe("space-1");
    const procedure = new URL(route.request().url()).pathname.split("/").at(-1);
    const json =
      procedure === "export"
        ? { text: "Run: run-1\n[Redacted export]\nexit 0\n", filename: "run-run-1.log" }
        : procedure === "list"
          ? { blocks: [] }
          : {
              rerunDisabledReason: "The computer or its workspace changed since this command ran.",
            };
    await route.fulfill({ json: { json } });
  });
  await page.goto("/e2e/fixtures/command-blocks.html");
  const block = page.getByTestId("command-block").first();
  const toggle = block.getByRole("button", { name: /Ran/ });
  await expect(toggle).toContainText("Ran `pnpm test` in ~/work · 12 s · exit 0");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("Completion not recorded")).toBeVisible();
  await expect(block.getByText("Tests passed.", { exact: false })).not.toBeVisible();
  const foldedHeight = (await block.boundingBox())!.height;
  await captureScreenshot(page, testInfo, "command-blocks-folded");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(block.locator("pre")).toContainText("stdout:");
  await expect(block.locator("pre")).toContainText("stderr:");
  await expect(block.locator("pre")).toContainText("<script>");
  expect(await page.evaluate(() => "commandExecuted" in window)).toBe(false);
  await expect(block.getByRole("button", { name: "Rerun", exact: true })).toBeDisabled();
  await block.getByLabel("Search run output").fill("missing");
  await block.getByRole("button", { name: "Search", exact: true }).click();
  await expect(block.getByText("No matching output.")).toBeVisible();
  const downloaded = page.waitForEvent("download");
  await block.getByRole("button", { name: "Export run", exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("run-run-1.log");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString("utf8")).toContain("[Redacted export]");
  await captureScreenshot(page, testInfo, "command-blocks-expanded");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect.poll(async () => (await block.boundingBox())!.height).toBe(foldedHeight);
  await expect(block.getByRole("button", { name: "Export run", exact: true })).not.toBeVisible();
});
