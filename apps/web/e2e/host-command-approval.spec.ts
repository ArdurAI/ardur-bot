import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("host command approvals display all arguments literally and support expansion", async ({
  page,
}, testInfo) => {
  await page.goto("/src/components/__fixtures__/approval.html");
  const details = page.locator("details");
  const preview = details.locator("pre");
  await expect(details).toHaveAttribute("open", "");
  await expect(preview).toContainText("'gh' 'issue' 'create'");
  const contents = await preview.textContent();
  expect(contents).toContain("x".repeat(3000));
  expect(contents).toContain("y".repeat(3000));
  expect(contents).toContain("**tail** <b>literal</b> $(false)");
  expect(contents).toContain("Working directory: '/workspace'");
  await expect(preview.locator("b, a")).toHaveCount(0);
  await preview.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await captureScreenshot(page, testInfo, "host-command-approval-full-preview");
  await details.locator("summary").click();
  await expect(preview).not.toBeVisible();
  await details.locator("summary").click();
  await expect(preview).toBeVisible();
  expect(await preview.textContent()).toBe(contents);
  await expect(page.getByRole("button", { name: "Always allow this tool" })).toHaveCount(0);
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(page.getByText("Allowed once", { exact: true })).toBeVisible();
});
