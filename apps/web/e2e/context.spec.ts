import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("Chief of Staff settings show two group briefs and a default-routed run", async ({
  page,
}, testInfo) => {
  await signup(page, `context-${Date.now()}@example.test`, "password12", "Context fixture");
  await completeOnboarding(page);
  const chiefId = activeBotId(page);
  const builder = await rpc<{ id: string }>(page, "bots/create", {
    name: "Builder",
    title: "",
    description: "",
    computerMode: "team",
  });
  const groups = [];
  for (const name of ["Alpha", "Beta"]) {
    const group = await rpc<{ id: string }>(page, "groups/create", {
      name,
      botIds: [chiefId, builder.id],
    });
    groups.push(group);
    await rpc(page, "briefs/update", {
      botId: chiefId,
      groupId: group.id,
      expectedRevision: 0,
      content: `## Goal\nRelease ${name}\n## Open items\nReview ${name}`,
    });
  }
  await page.reload();
  await page.locator("main").getByRole("button", { name: "Chief", exact: true }).click();
  const settings = page.getByTestId("bot-settings");
  const context = settings
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: /^Context$/ }) })
    .first();
  await context.locator(":scope > summary").click();
  await expect(context.getByRole("spinbutton", { name: "Concurrent runs" })).toHaveValue("3");
  for (const name of ["Alpha", "Beta"]) {
    const brief = context
      .locator("details")
      .filter({ has: page.locator("summary", { hasText: new RegExp(`^${name}$`) }) });
    await brief.locator("summary").click();
    await expect(brief).toContainText(`Release ${name}`);
  }
  await captureScreenshot(page, testInfo, "context-two-group-briefs");
  const sent = await rpc<{ runId: string }>(page, "threads/send", {
    groupId: groups[0]!.id,
    text: "Hello",
  });
  await expect
    .poll(
      async () =>
        (
          await rpc<{ contextRun: { id: string; status: string; routingRule: string } }>(
            page,
            "threads/get",
            { groupId: groups[0]!.id },
          )
        ).contextRun?.status,
    )
    .toBe("completed");
  await page.goto(`/app/g/${groups[0]!.id}`);
  await page.locator("main").getByRole("button", { name: "Context", exact: true }).click();
  const headerContext = page.getByTestId("run-context");
  await expect(headerContext).toContainText("Routed by default");
  await expect(headerContext).toContainText("Time to first token");
  await expect(headerContext).toContainText("Cache hits");
  await expect(headerContext).toContainText("Queue wait");
  const snapshot = await rpc<{ contextRun: { id: string; routingRule: string } }>(
    page,
    "threads/get",
    {
      groupId: groups[0]!.id,
    },
  );
  expect(snapshot.contextRun).toMatchObject({ id: sent.runId, routingRule: "default" });
  await captureScreenshot(page, testInfo, "context-default-route-metrics");
});
