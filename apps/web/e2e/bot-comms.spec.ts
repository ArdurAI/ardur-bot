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

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A receipt chip for one peer in any state the exchange can reach after delivery. */
function receiptChip(page: Page, direction: "to" | "from", peer: string, reader: string) {
  const initial = direction === "to" ? "(Sent|Delivered) to" : "(Message|Delivered) from";
  const advanced = `(Read by ${escapeRegExp(reader)}|Replied|Waiting for a turn) · ${direction}`;
  const name = new RegExp(`^(${initial}|${advanced}) ${escapeRegExp(peer)}$`);
  return page.getByTestId("peer-receipt-chip").and(page.getByRole("button", { name })).first();
}

test("shows the first goal desk request, independent check, and coordinator answer", async ({
  page,
}, testInfo) => {
  test.setTimeout(360_000);
  await signup(
    page,
    `desk-loop-${testInfo.workerIndex}-${Date.now()}@example.test`,
    "password12",
    "Desk loop",
  );
  await completeOnboarding(page);
  const releaseOwner = await claimDeploymentOwner(page);
  try {
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

    // Receipts advance as soon as the recipient reads and replies, so accept every later state.
    await page.goto(`/app/g/${group.id}`);
    await expect(receiptChip(page, "to", "Worker", "Worker")).toBeVisible({ timeout: 60_000 });
    await page.goto(`/app/${worker.id}`);
    await expect(receiptChip(page, "from", "Chief of Staff", "Worker")).toBeVisible({
      timeout: 60_000,
    });
    await page.goto(`/app/g/${group.id}`);
    await expect(receiptChip(page, "to", "Reviewer", "Reviewer")).toBeVisible({
      timeout: 60_000,
    });
    await expect(
      page.getByText("Results show oldest first; sort results by createdAt ascending.").last(),
    ).toBeVisible({ timeout: 60_000 });
    // Scope to the transcript: the group list preview repeats the final answer in the sidebar.
    await expect(
      page.getByTestId("transcript").getByText(/The fixture does not say how ties are ordered/),
    ).toBeVisible({
      timeout: 60_000,
    });
    await captureScreenshot(page, testInfo, "bot-comms-first-loop");
  } finally {
    await releaseOwner();
  }
});
