import { expect, test } from "@playwright/test";
import { suggestedModelEffort } from "../../../packages/adapters/src/model-defaults";
import { listPiCatalog } from "../../../packages/adapters/src/pi-models";
import {
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  openNewGroup,
  rpc,
  signup,
} from "./helpers";

test("the group header keeps long member models on one truncating line", async ({
  page,
}, testInfo) => {
  await signup(page, `group-layout-${Date.now()}@ardurbot.test`, "password12", "Group layout");
  await completeOnboarding(page);
  await page.waitForURL(/\/app\/(?!bots$)[^/]+$/);
  const catalog = listPiCatalog();
  const pick = (provider: string) => {
    const entry = catalog.find((item) => item.provider === provider && !item.placeholder);
    expect(entry).toBeDefined();
    return entry!;
  };
  // Two providers so each member shows its own long model label.
  const choices = [pick("anthropic"), pick("openai")];
  const credentials = new Map<string, string>();
  for (const entry of choices) {
    const credential = await rpc<{ id: string }>(page, "models/connect", {
      provider: entry.provider,
      apiKey: "fixture-key",
    });
    credentials.set(entry.provider, credential.id);
  }
  await page.reload();
  const first = await createNamedBot(page, "Partnership Liaison Archivist");
  const second = await createNamedBot(page, "Documentation Synthesis Wrangler");
  await openNewGroup(page);
  const panel = page.getByTestId("side-panel");
  await panel.locator("label:has-text('Name') input").fill("Long header room");
  await panel.getByRole("button", { name: "Partnership Liaison Archivist" }).click();
  await panel.getByRole("button", { name: "Documentation Synthesis Wrangler" }).click();
  await panel.getByRole("button", { name: "Create group", exact: true }).click();
  await page.waitForURL(/\/app\/g\/[^/]+$/);
  const groupId = page.url().split("/").at(-1)!;
  const pinFor = (provider: string) => {
    const entry = choices.find((item) => item.provider === provider)!;
    return {
      runtimeKind: "pi" as const,
      provider: entry.provider,
      modelId: entry.id,
      effort: suggestedModelEffort(entry.thinkingLevels ?? ["off"]),
      credentialId: credentials.get(entry.provider)!,
    };
  };
  const pins = new Map([
    [first, pinFor("anthropic")],
    [second, pinFor("openai")],
  ]);
  const group = await rpc<{
    members: Array<{ botId: string; memberId: string; modelPinRevision: number }>;
  }>(page, "groups/get", { groupId });
  for (const member of group.members) {
    await rpc(page, "groups/setMemberModelPin", {
      groupId,
      botId: member.botId,
      memberId: member.memberId,
      expectedRevision: member.modelPinRevision,
      pin: pins.get(member.botId),
    });
  }
  await page.reload();
  const line = page.getByTestId("group-participant-models");
  await expect(line).toBeVisible();
  await expect(line).toContainText("Partnership Liaison Archivist");
  await expect(line).toContainText("Documentation Synthesis Wrangler");
  for (const entry of choices) {
    await expect(line.getByLabel(`Using ${entry.id}`)).toBeVisible();
  }

  await page.setViewportSize({ width: 390, height: 844 });
  const metrics = await line.evaluate((el) => {
    const header = el.closest("div.app-drag");
    const lineBox = el.getBoundingClientRect();
    const headerBox = header?.getBoundingClientRect();
    return {
      height: lineBox.height,
      right: lineBox.right,
      headerRight: headerBox?.right ?? 0,
      fontSize: parseFloat(getComputedStyle(el).fontSize),
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      title: el.getAttribute("title") ?? "",
    };
  });
  // One line: a wrapped second line of body text would add at least another font size.
  expect(metrics.height).toBeLessThanOrEqual(metrics.fontSize * 2);
  // Inside the header: the line never runs past the header's right edge.
  expect(metrics.right).toBeLessThanOrEqual(metrics.headerRight + 0.5);
  // The text really overflows and is ellipsised, while the full text survives in the title.
  expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
  expect(metrics.title).toContain("Partnership Liaison Archivist");
  expect(metrics.title).toContain("Documentation Synthesis Wrangler");
  await captureScreenshot(page, testInfo, "group-header-truncation");
});
