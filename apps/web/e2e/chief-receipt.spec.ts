import type { ThreadSendResult, ThreadSnapshot } from "@ardurbot/contracts";
import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("chief receipts paint from accepted sends and survive reload without duplication", async ({
  page,
}, info) => {
  await page.addInitScript(() => {
    globalThis.__ardurTrace = { capacity: 512 };
  });
  await signup(page, `chief-receipt-${Date.now()}@example.test`, "password12", "Receipt fixture");
  await completeOnboarding(page);
  const chiefId = activeBotId(page);
  const worker = await rpc<{ id: string }>(page, "bots/create", {
    name: "Renamed member",
    title: "documentation",
    description: "",
    computerMode: "team",
  });
  const group = await rpc<{ id: string }>(page, "groups/create", {
    name: "Receipt fixture",
    botIds: [worker.id, chiefId],
  });
  await rpc(page, "groups/update", { groupId: group.id, coordinatorBotId: chiefId });
  await page.goto(`/app/g/${group.id}`);
  const composer = page.getByTestId("composer-bar").locator("textarea");
  await expect(composer).toBeVisible();
  for (const fixture of [
    {
      configuration: "healthy-idle-greeting-ci",
      text: "Hi everyone.",
      kind: "receipt-only",
      copy: "Hi everyone.",
    },
    {
      configuration: "healthy-ordinary-work-ci",
      text: "Put this long document in Notion.",
      kind: "work",
      copy: "Got it — I’ll choose a team member to put this in Notion.",
    },
  ]) {
    const times: number[] = [];
    for (let sample = 0; sample < 10; sample++) {
      await composer.fill(fixture.text);
      // A visible receipt can precede completion of the previous send's snapshot refresh.
      await expect(
        page.getByTestId("composer-bar").getByRole("button", { name: "Send", exact: true }),
      ).toBeEnabled();
      const start = await page.evaluate(() => performance.now());
      const response = page.waitForResponse((response) =>
        response.url().endsWith("/rpc/threads/send"),
      );
      await composer.press("Enter");
      const body = (await (await response).json()) as { json: ThreadSendResult };
      expect(body.json.kind).toBe(fixture.kind);
      const receipt = body.json.receipt!;
      await expect(
        page.locator(`[data-message-id="${receipt.id}"] [data-testid="chief-receipt"]`),
      ).toHaveText(fixture.copy);
      await page.waitForFunction(
        (requestId) =>
          globalThis.__ardurTrace?.points?.some(
            (point) => point.traceId === requestId && point.boundary === "client.receipt.painted",
          ),
        receipt.requestMessageId,
      );
      const painted = await page.evaluate(
        (requestId) =>
          globalThis.__ardurTrace!.points!.find(
            (point) => point.traceId === requestId && point.boundary === "client.receipt.painted",
          )!.at,
        receipt.requestMessageId,
      );
      times.push(painted - start);
      await expect(composer).toBeEnabled();
    }
    times.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        measurement: "send-intent-to-visible-chief-receipt",
        configuration: fixture.configuration,
        samples: times.length,
        p50Ms: times[4],
        p95Ms: times[9],
        maxMs: times[9],
        misses: times.filter((time) => time >= 2000).length,
      }),
    );
    expect(times.every((time) => time < 2000)).toBe(true);
    await captureScreenshot(page, info, `chief-receipt-${fixture.kind}`);
  }
  await page.reload();
  await expect(page.getByTestId("chief-receipt")).toHaveCount(20);
  await expect(page.getByTestId("chief-receipt").first()).toHaveText("Hi everyone.");
});

test("the real room renders a scripted corrected dispatch after reload", async ({ page }, info) => {
  await signup(
    page,
    `correction-room-${Date.now()}@example.test`,
    "password12",
    "Correction fixture",
  );
  await completeOnboarding(page);
  const chiefId = activeBotId(page);
  const worker = await rpc<{ id: string }>(page, "bots/create", {
    name: "Member",
    title: "documentation",
    description: "",
    computerMode: "team",
  });
  const group = await rpc<{ id: string }>(page, "groups/create", {
    name: "Correction fixture",
    botIds: [chiefId, worker.id],
  });
  await rpc(page, "groups/update", { groupId: group.id, coordinatorBotId: chiefId });
  const snapshot = await rpc<ThreadSnapshot>(page, "threads/get", { groupId: group.id });
  const createdAt = new Date().toISOString();
  let confirmed = false;
  // Script only the saved projection; exercise Shell and the actual room, not a duplicate renderer.
  await page.route("**/rpc/threads/get", (route) =>
    route.fulfill({
      json: {
        json: {
          ...snapshot,
          messages: [
            {
              id: "fixture-owner",
              threadId: snapshot.threadId,
              seq: 1,
              role: "user",
              createdAt,
              blocks: [{ kind: "text", text: "dont send to Member" }],
            },
            {
              id: "fixture-receipt",
              threadId: snapshot.threadId,
              seq: 2,
              role: "bot",
              botId: chiefId,
              createdAt,
              blocks: [
                {
                  kind: "chief_receipt",
                  key: "exclude-member",
                  memberName: "Member",
                  requestMessageId: "fixture-owner",
                  text: "Got it — I’ll keep Member off this task.",
                },
              ],
            },
            {
              id: "fixture-dispatch",
              threadId: snapshot.threadId,
              seq: 3,
              role: "bot",
              botId: chiefId,
              createdAt,
              blocks: [
                {
                  kind: "handoff",
                  fromBotId: chiefId,
                  toBotId: worker.id,
                  text: "Preparation request",
                  chiefDispatch: {
                    requestMessageId: "fixture-owner",
                    revision: 1,
                    memberId: worker.id,
                    memberName: "Member",
                    state: "messaged",
                    reason: "eligible",
                    stop: {
                      revision: 2,
                      memberName: "Member",
                      state: confirmed ? "confirmed" : "requested",
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    }),
  );
  await page.goto(`/app/g/${group.id}`);
  await expect(page.getByTestId("chief-receipt")).toHaveText(
    "Got it — I’ll keep Member off this task.",
  );
  await expect(page.getByTestId("chief-dispatch")).toContainText("Told Member to stand down");
  await expect(page.getByTestId("chief-activity")).toHaveText("Stopping Member");
  await captureScreenshot(page, info, "chief-correction-room-requested");
  confirmed = true;
  await page.reload();
  await expect(page.getByTestId("chief-dispatch")).toHaveCount(1);
  await expect(page.getByTestId("chief-dispatch")).toContainText("Member stood down");
  await expect(page.getByTestId("chief-activity")).toHaveCount(0);
  await captureScreenshot(page, info, "chief-correction-room-confirmed");
});
