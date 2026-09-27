import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { dashboardFixture } from "./dashboard-fixture";

const outputDir = process.env.SITE_SCREENSHOTS_DIR;
test.skip(!outputDir, "Website screenshots run in the site assets publish job.");
test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light" });

async function captureSiteScreenshot(page: Page, id: string) {
  if (!outputDir) throw new Error("SITE_SCREENSHOTS_DIR is required.");
  await mkdir(outputDir, { recursive: true });
  const file = path.join(outputDir, `${id}.png`);
  await page.screenshot({ path: file, animations: "disabled", caret: "hide", fullPage: false });
  if ((await stat(file)).size > 1_500_000) {
    throw new Error(`${id}.png exceeds the 1.5 MB site assets limit.`);
  }
}

test("captures the bot and group conversations from seeded demo data", async ({ page }) => {
  const fixture = dashboardFixture(2);
  const group = {
    id: "group",
    spaceId: "space",
    name: "Review team",
    pinned: false,
    sectionId: null,
    archivedAt: null,
    members: [
      { botId: "bot", name: "Reviewer", color: "slate", status: "idle" },
      { botId: "bot-1", name: "Reviewer 1", color: "slate", status: "idle" },
    ],
    threadId: "group-thread",
    preview: "",
    unread: false,
    updatedAt: "2026-09-24T12:00:00.000Z",
    createdAt: "2026-09-24T12:00:00.000Z",
  };
  const groupMessage = {
    id: "group-message",
    threadId: group.threadId,
    seq: 1,
    role: "bot",
    botId: "bot",
    blocks: [{ kind: "text", text: "The draft is ready for the team's review." }],
    createdAt: group.createdAt,
  };
  await page.clock.setFixedTime(new Date("2026-09-24T12:00:30.000Z"));
  await page.route("**/api/auth/get-session*", (route) => route.fulfill({ json: fixture.session }));
  await page.route("**/rpc/**", async (route) => {
    const procedure = new URL(route.request().url()).pathname.slice("/rpc/".length);
    if (procedure === "threads/subscribe") {
      await route.fulfill({ contentType: "text/event-stream", body: "" });
      return;
    }
    const input = route.request().postDataJSON()?.json as { groupId?: string } | undefined;
    const original = fixture.rpc(procedure, input);
    const result =
      procedure === "bootstrap"
        ? {
            ...(original as object),
            groups: [group],
            spaces: [{ ...(original as { spaces: object[] }).spaces[0], groups: [group] }],
          }
        : procedure === "spaces/list"
          ? {
              ...(original as object),
              current: { ...(original as { current: object }).current, groups: [group] },
              spaces: [{ ...(original as { spaces: object[] }).spaces[0], groups: [group] }],
            }
          : procedure === "groups/list"
            ? [group]
            : (procedure === "threads/get" || procedure === "threads/head") &&
                input?.groupId === group.id
              ? {
                  threadId: group.threadId,
                  groupId: group.id,
                  groupName: group.name,
                  members: group.members,
                  cursor: 1,
                  olderCursor: null,
                  run: null,
                  messages: [groupMessage],
                }
              : original;
    await route.fulfill({ json: { json: result } });
  });

  await page.goto("/app/bot");
  await expect(page.getByRole("button", { name: "Allow once", exact: true })).toBeVisible();
  await captureSiteScreenshot(page, "app-chat");

  await page.goto("/app/g/group");
  await expect(page.getByRole("combobox", { name: "Message Review team" })).toBeVisible();
  await expect(page.getByText("The draft is ready for the team's review.")).toBeVisible();
  await captureSiteScreenshot(page, "group-chat");
});
