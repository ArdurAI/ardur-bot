import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  claimDeploymentOwner,
  completeOnboarding,
  rpc,
  signup,
} from "./helpers";

test("holds a peer ask and lets the owner pause group and space traffic", async ({
  page,
}, testInfo) => {
  test.setTimeout(360_000);
  await signup(
    page,
    `s4-${testInfo.workerIndex}-${Date.now()}@ardurbot.test`,
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
      name: "Draft room",
      botIds: [coordinatorId, worker.id],
    });
    await rpc(page, "groups/update", { groupId: group.id, coordinatorBotId: coordinatorId });
    await page.goto(`/app/g/${group.id}`);
    await rpc(page, "goals/start", {
      groupId: group.id,
      objective: "S4 held ask fixture: request preparation of the public draft from Worker.",
      doneWhen: ["The owner reviews the draft request."],
      tokenLimit: 100_000,
      untilAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    await expect(
      page.getByTestId("ask-card").getByText("Coordinator wants Worker to prepare a team request."),
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      page.getByTestId("peer-receipt-chip").filter({ hasText: "Waiting for your approval" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Deny" }).last().click();
    await expect(
      page.getByTestId("peer-receipt-chip").filter({ hasText: "Not approved" }),
    ).toBeVisible();
    await page.getByTestId("bot-settings-trigger").click();
    const controls = page.getByTestId("peer-traffic-controls");
    await expect(controls).toBeVisible();
    await controls.getByRole("button", { name: "Pause group messages" }).click();
    await expect(controls.getByRole("button", { name: "Resume group messages" })).toBeVisible();
    await controls.getByRole("button", { name: "Pause team messages" }).click();
    await expect(controls.getByRole("button", { name: "Resume team messages" })).toBeVisible();
    const policy = await rpc<{ effectivePaused: boolean }>(page, "botComms/getPolicy", {
      groupId: group.id,
    });
    expect(policy.effectivePaused).toBe(true);
    await captureScreenshot(page, testInfo, "bot-comms-s4-hold-and-pause");
  } finally {
    await releaseOwner();
  }
});
