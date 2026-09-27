import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  claimDeploymentOwner,
  completeOnboarding,
  rpc,
  signup,
} from "./helpers";

const fixture = "Results show newest first; sort results by createdAt ascending";

async function receiptGate(page: Page, action: "arm" | "accept" | "reply", botId?: string) {
  const apiUrl = process.env.API_URL;
  const token = process.env.TESTKIT_E2E_OWNER_TOKEN;
  if (!apiUrl || !token || process.env.VERIFY_DATABASE !== "1")
    throw new Error("Receipt gate requires the isolated E2E harness.");
  const response = await page.request.post(`${apiUrl}/__e2e/receipt-gate`, {
    headers: { "x-e2e-owner-token": token },
    data: { action, botId },
  });
  if (!response.ok()) throw new Error(`Receipt gate ${action} failed: ${response.status()}`);
}

async function receiptTimeline(page: Page, outboundMessageId: string, inboundMessageId: string) {
  const apiUrl = process.env.API_URL;
  const token = process.env.TESTKIT_E2E_OWNER_TOKEN;
  if (!apiUrl || !token || process.env.VERIFY_DATABASE !== "1")
    throw new Error("Receipt timeline requires the isolated E2E harness.");
  const query = new URLSearchParams({ outboundMessageId, inboundMessageId });
  const response = await page.request.get(`${apiUrl}/__e2e/receipt-timeline?${query}`, {
    headers: { "x-e2e-owner-token": token },
  });
  if (!response.ok()) throw new Error(`Receipt timeline failed: ${response.status()}`);
  return (await response.json()) as {
    state: string;
    readAt: string | null;
    repliedAt: string | null;
  };
}

async function startFixture(page: Page, groupId: string) {
  await rpc(page, "goals/start", {
    groupId,
    objective: `You coordinate this goal. Ask Worker to identify the contradiction: ${fixture}. Report the corrected wording after its result.`,
    doneWhen: ["Worker result identifies the corrected wording."],
    tokenLimit: 100_000,
    untilAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
}

test("shows one delivery chip advance through Delivered, Read and Replied in both threads", async ({
  page,
}, testInfo) => {
  await signup(page, `receipt-loop-${Date.now()}@ardurbot.test`, "password12", "Receipt loop");
  await completeOnboarding(page);
  const releaseOwner = await claimDeploymentOwner(page);
  try {
    const coordinatorId = activeBotId(page);
    const worker = await rpc<{ id: string }>(page, "bots/create", {
      name: "Worker",
      title: "Research",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const group = await rpc<{ id: string }>(page, "groups/create", {
      name: "Receipt fixture",
      botIds: [coordinatorId, worker.id],
    });
    await rpc(page, "groups/update", { groupId: group.id, coordinatorBotId: coordinatorId });
    const workerPage = await page.context().newPage();
    let gateArmed = false;
    try {
      await receiptGate(page, "arm", worker.id);
      gateArmed = true;
      await workerPage.goto(`/app/${worker.id}`);
      await page.goto(`/app/g/${group.id}`);
      await startFixture(page, group.id);
      const roomChip = page.getByTestId("peer-receipt-chip");
      const deskChip = workerPage.getByTestId("peer-receipt-chip");
      const deliveredRoom = roomChip.filter({ hasText: "Delivered to Worker" });
      const deliveredDesk = deskChip.filter({ hasText: "Delivered from" });
      await expect(deliveredRoom).toHaveCount(1, {
        timeout: 60_000,
      });
      await expect(deliveredDesk).toHaveCount(1);
      const roomMessageId = await deliveredRoom
        .locator("xpath=ancestor::*[@data-message-id][1]")
        .getAttribute("data-message-id");
      const deskMessageId = await deliveredDesk
        .locator("xpath=ancestor::*[@data-message-id][1]")
        .getAttribute("data-message-id");
      if (!roomMessageId || !deskMessageId) throw new Error("Receipt message IDs are unavailable.");
      const roomRequest = page.locator(
        `[data-message-id="${roomMessageId}"] [data-testid="peer-receipt-chip"]`,
      );
      const deskRequest = workerPage.locator(
        `[data-message-id="${deskMessageId}"] [data-testid="peer-receipt-chip"]`,
      );
      await receiptGate(page, "accept");
      await expect(roomRequest).toHaveText("Read by Worker", {
        timeout: 60_000,
      });
      await expect(deskRequest).toHaveText("Read by Worker");
      await receiptGate(page, "reply");
      gateArmed = false;
      await expect(roomRequest).toHaveText("Replied", {
        timeout: 60_000,
      });
      await expect(deskRequest).toHaveText("Replied");
      await expect(roomRequest).toHaveCount(1);
      await expect(deskRequest).toHaveCount(1);
      const timeline = await receiptTimeline(page, roomMessageId, deskMessageId);
      expect(timeline.state).toBe("replied");
      expect(timeline.readAt).not.toBeNull();
      expect(timeline.repliedAt).not.toBeNull();
      expect(Date.parse(timeline.readAt!)).toBeLessThan(Date.parse(timeline.repliedAt!));
      await captureScreenshot(page, testInfo, "bot-comms-receipts");
    } finally {
      if (gateArmed) await receiptGate(page, "reply");
      await workerPage.close();
    }
  } finally {
    await releaseOwner();
  }
});

test("shows Waiting for a turn while unrelated owner work occupies the recipient", async ({
  page,
}) => {
  await signup(page, `receipt-queued-${Date.now()}@ardurbot.test`, "password12", "Queued receipt");
  await completeOnboarding(page);
  const releaseOwner = await claimDeploymentOwner(page);
  let workerId: string | undefined;
  try {
    const coordinatorId = activeBotId(page);
    const worker = await rpc<{ id: string }>(page, "bots/create", {
      name: "Worker",
      title: "Research",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    workerId = worker.id;
    const group = await rpc<{ id: string }>(page, "groups/create", {
      name: "Queued fixture",
      botIds: [coordinatorId, worker.id],
    });
    await rpc(page, "groups/update", { groupId: group.id, coordinatorBotId: coordinatorId });
    await rpc(page, "threads/send", { botId: worker.id, text: "Keep working until I stop you" });
    await page.goto(`/app/g/${group.id}`);
    await startFixture(page, group.id);
    await expect(
      page.getByTestId("peer-receipt-chip").filter({ hasText: "Waiting for a turn" }),
    ).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId("peer-receipt-chip")).toHaveCount(1);
  } finally {
    if (workerId) await rpc(page, "threads/stop", { botId: workerId }).catch(() => undefined);
    await releaseOwner();
  }
});
