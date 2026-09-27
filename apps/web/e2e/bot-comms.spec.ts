import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("shows the first goal desk request, independent check, and coordinator answer", async ({
  page,
}, testInfo) => {
  await signup(page, `desk-loop-${Date.now()}@ardurbot.test`, "password12", "Desk loop");
  await completeOnboarding(page);
  const chiefId = activeBotId(page);
  await rpc(page, "bots/update", { botId: chiefId, name: "Chief of Staff" });
  const worker = await rpc<{ id: string }>(page, "bots/create", {
    name: "Worker",
    title: "Research",
    description: "",
    instructions: "",
    notifyOnFinish: true,
  });
  const reviewer = await rpc<{ id: string }>(page, "bots/create", {
    name: "Reviewer",
    title: "Review",
    description: "",
    instructions: "",
    notifyOnFinish: true,
  });
  const group = await rpc<{ id: string }>(page, "groups/create", {
    name: "Fixture review",
    botIds: [chiefId, worker.id, reviewer.id],
  });
  await rpc(page, "groups/update", { groupId: group.id, coordinatorBotId: chiefId });
  await rpc(page, "goals/start", {
    groupId: group.id,
    objective:
      "You coordinate this goal. Use message_bot with a bounded task card to ask Worker to identify the contradiction in this fixture: Results show newest first; sort results by createdAt ascending. After Worker finishes, send its proposed correction to Reviewer with a card asking for an independent check against the fixture. Use the completion events rather than polling. Report the reviewed wording and any remaining uncertainty.",
    doneWhen: [
      "Worker result exists; a different Reviewer checked it; the final report includes the corrected sentence.",
    ],
    tokenLimit: 100_000,
    untilAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });

  await page.goto(`/app/g/${group.id}`);
  await expect(
    page.getByTestId("peer-receipt-chip").filter({ hasText: "Delivered to Worker" }),
  ).toBeVisible({ timeout: 60_000 });
  await page.goto(`/app/${worker.id}`);
  await expect(
    page.getByTestId("peer-receipt-chip").filter({ hasText: "Delivered from Chief of Staff" }),
  ).toBeVisible({ timeout: 60_000 });
  await page.goto(`/app/g/${group.id}`);
  await expect(
    page.getByTestId("peer-receipt-chip").filter({ hasText: "Delivered to Reviewer" }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(
    page.getByText("Results show oldest first; sort results by createdAt ascending.").last(),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/The fixture does not say how ties are ordered/)).toBeVisible({
    timeout: 60_000,
  });
  await captureScreenshot(page, testInfo, "bot-comms-first-loop");
});
