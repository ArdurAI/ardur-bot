import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  claimDeploymentOwner,
  completeOnboarding,
  rpc,
  signup,
} from "./helpers";

test("shows the exact effect on a peer hold card and lets the owner allow it once", async ({
  page,
}, testInfo) => {
  test.setTimeout(360_000);
  await signup(
    page,
    `s4b-${testInfo.workerIndex}-${Date.now()}@example.test`,
    "password12",
    "Fixture owner",
  );
  await completeOnboarding(page);
  const releaseOwner = await claimDeploymentOwner(page);
  try {
    const coordinatorId = activeBotId(page);
    await rpc(page, "bots/update", { botId: coordinatorId, name: "Coordinator" });
    const worker = await rpc<{ id: string }>(page, "bots/create", {
      name: "Worker",
      title: "Drafting",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const group = await rpc<{ id: string }>(page, "groups/create", {
      name: "Publish room",
      botIds: [coordinatorId, worker.id],
    });
    await rpc(page, "groups/update", { groupId: group.id, coordinatorBotId: coordinatorId });
    await page.goto(`/app/g/${group.id}`);
    await rpc(page, "goals/start", {
      groupId: group.id,
      objective: "S4b exact effect fixture: publish the public draft from Worker.",
      doneWhen: ["The owner reviews the exact write request."],
      tokenLimit: 100_000,
      untilAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    const card = page.getByTestId("ask-card");
    await expect(card.getByText("Coordinator wants Worker to run destination.write.")).toBeVisible({
      timeout: 60_000,
    });
    await expect(card.getByText(/destination\.write · destination:drafts/)).toBeVisible();
    await expect(card.getByText(/"title":"Public fixture draft"/)).toBeVisible();
    await expect(
      page.getByTestId("peer-receipt-chip").filter({ hasText: "Waiting for your approval" }),
    ).toBeVisible();
    await card.getByRole("button", { name: "Allow once" }).click();
    await expect(card.getByText("Allowed once")).toBeVisible();
    await expect(
      page.getByTestId("peer-receipt-chip").filter({ hasText: "Waiting for your approval" }),
    ).toHaveCount(0);
    await captureScreenshot(page, testInfo, "bot-comms-s4b-exact-effect-card");
  } finally {
    await releaseOwner();
  }
});
