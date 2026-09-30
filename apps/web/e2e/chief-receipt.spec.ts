import type { ThreadSendResult } from "@ardurbot/contracts";
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
  const times: number[] = [];
  for (let sample = 0; sample < 10; sample++) {
    await composer.fill("Hi everyone.");
    const start = await page.evaluate(() => performance.now());
    const response = page.waitForResponse((response) =>
      response.url().endsWith("/rpc/threads/send"),
    );
    await composer.press("Enter");
    const body = (await (await response).json()) as { json: ThreadSendResult };
    expect(body.json.kind).toBe("receipt-only");
    const receipt = body.json.receipt!;
    await expect(
      page.locator(`[data-message-id="${receipt.id}"] [data-testid="chief-receipt"]`),
    ).toHaveText("Hi everyone.");
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
      configuration: "healthy-idle-ci",
      samples: times.length,
      p50Ms: times[4],
      p95Ms: times[9],
      maxMs: times[9],
      misses: times.filter((time) => time >= 2000).length,
    }),
  );
  expect(times.every((time) => time < 2000)).toBe(true);
  await captureScreenshot(page, info, "chief-receipt-greeting");
  await page.reload();
  await expect(page.getByTestId("chief-receipt")).toHaveCount(10);
  await expect(page.getByTestId("chief-receipt").first()).toHaveText("Hi everyone.");
});
