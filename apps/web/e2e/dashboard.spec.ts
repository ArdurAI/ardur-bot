import { expect, test } from "@playwright/test";
import { dashboardFixture } from "./dashboard-fixture";
import { captureScreenshot } from "./helpers";

test.use({ viewport: { width: 1280, height: 900 } });

test("Dashboard opens first, preserves Bots navigation and approves through the existing thread action", async ({
  page,
}, testInfo) => {
  const fixture = dashboardFixture();
  await page.clock.setFixedTime(new Date("2026-09-24T12:00:30.000Z"));
  let releaseBootstrap!: () => void;
  const bootstrapReady = new Promise<void>((resolve) => {
    releaseBootstrap = resolve;
  });
  let releaseNow!: () => void;
  const nowReady = new Promise<void>((resolve) => {
    releaseNow = resolve;
  });
  await page.route(
    /\/(?:assets\/NowPanel-[^/]+\.js|src\/pages\/dashboard\/NowPanel\.tsx)(?:\?|$)/,
    async (route) => {
      await nowReady;
      await route.continue();
    },
  );
  await page.route("**/api/auth/get-session*", (route) => route.fulfill({ json: fixture.session }));
  await page.route("**/rpc/**", async (route) => {
    const procedure = new URL(route.request().url()).pathname.slice("/rpc/".length);
    if (procedure === "bootstrap") await bootstrapReady;
    if (procedure === "threads/subscribe") {
      await route.fulfill({ contentType: "text/event-stream", body: "" });
    } else {
      await route.fulfill({
        json: {
          json: fixture.rpc(procedure, route.request().postDataJSON()?.json),
        },
      });
    }
  });
  await page.goto("/app");
  try {
    await expect(page.getByTestId("dashboard")).toBeVisible();
    await expect(page.getByTestId("dashboard").getByRole("heading")).toHaveText([
      "Dashboard",
      "Now",
      "Work",
      "Computers",
      "Connections",
      "Routines",
      "Usage",
      "Learning",
      "Governance",
    ]);
    await expect(page.getByTestId("dashboard").locator('[aria-busy="true"]')).toHaveCount(8);
  } finally {
    releaseBootstrap();
  }
  try {
    await expect(page.locator('[data-panel="now"] [aria-busy="true"]')).toBeVisible();
    await expect(page.locator('[data-panel="connections"]')).toContainText("No connections");
    await expect(page.locator('[data-panel="governance"] a')).toBeVisible();
  } finally {
    releaseNow();
  }
  await expect(page).toHaveTitle("Dashboard — Ardur Bot");
  await expect(page.getByText("Waiting for your approval", { exact: true })).toBeVisible();
  const governance = page.locator('[data-panel="governance"]');
  await expect(governance.getByRole("link")).toHaveText(
    "Governance and encryption are not part of this build yet.",
  );
  await expect(governance.getByRole("button")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "dashboard-overview");
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect
    .poll(() => fixture.approvedInput)
    .toEqual({
      botId: "bot",
      threadId: "thread",
      runId: "run",
      messageId: "message",
      answer: "allow",
    });
  await expect(page.getByText("Nothing running", { exact: true })).toBeVisible();
  await page.keyboard.press("Control+2");
  await expect(page).toHaveURL(/\/app\/(?:bots|bot)$/);
  await expect(page.getByTestId("bot-settings-trigger")).toBeVisible();
  await expect(page).toHaveTitle("Bots — Ardur Bot");
  const cachedRenderMs = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const start = performance.now();
        const observer = new MutationObserver(() => {
          if (document.querySelectorAll('[data-testid="dashboard"] [data-panel]').length !== 8)
            return;
          if (document.querySelector('[data-testid="dashboard"] [aria-busy="true"]')) return;
          observer.disconnect();
          requestAnimationFrame(() =>
            requestAnimationFrame(() => resolve(performance.now() - start)),
          );
        });
        observer.observe(document.body, { childList: true, subtree: true });
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "1", ctrlKey: true, cancelable: true }),
        );
      }),
  );
  await testInfo.attach("dashboard-cached-render", {
    body: JSON.stringify({ milliseconds: cachedRenderMs }),
    contentType: "application/json",
  });
  expect(cachedRenderMs).toBeLessThan(200);
  await expect(page.getByTestId("dashboard")).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("combobox", { name: "Open to", exact: true }).selectOption("bots");
  await page.keyboard.press("Escape");
  await page.goto("/app");
  await expect(page).toHaveTitle("Bots — Ardur Bot");
  await expect(page.getByTestId("dashboard")).toHaveCount(0);
  await page.keyboard.press("Control+1");
  await expect(page.getByTestId("dashboard")).toBeVisible();
  await page.keyboard.press("Control+3");
  await expect(page).toHaveURL(/\/app\/ide$/);
  await expect(page).toHaveTitle("IDE — Ardur Bot");
  await page.keyboard.press("Control+1");
  await page
    .getByRole("navigation", { name: "Dashboard", exact: true })
    .getByRole("link", { name: "Board", exact: true })
    .click();
  await expect(page).toHaveURL(/\/app\/board$/);
  await expect(page.getByRole("heading", { name: "Board", exact: true })).toBeVisible();
  await expect(page).toHaveTitle("Board — Ardur Bot");
  const card = page.locator('[data-board-item="work-1"]');
  await card.dragTo(page.locator('[data-board-column="in_progress"]'));
  await expect(
    page.locator('[data-board-column="in_progress"] [data-board-item="work-1"]'),
  ).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    page.locator('[data-board-column="ready"] [data-board-item="work-1"]'),
  ).toBeVisible();
  await page.goto("/app/board?workspace=board&item=work-1");
  await expect(page.getByRole("dialog")).toContainText("Check the work");
  await expect(page).toHaveTitle("Board — Ardur Bot");
  await page.getByRole("button", { name: "Follow", exact: true }).click();
  await expect(page.getByRole("button", { name: "Unfollow", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "dashboard-board-item");
  await page.keyboard.press("Escape");
  await page
    .getByRole("navigation", { name: "Dashboard", exact: true })
    .getByRole("link", { name: "Overview", exact: true })
    .click();
  await expect(page.locator('[data-panel="work"]')).toContainText("Plan next step");
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  await page.goto("/app/team");
  await expect(page.getByRole("heading", { name: "Team", exact: true })).toBeVisible();
});

test("HTTP/1.1 keeps approvals and summary refresh usable with twelve bot threads", async ({
  page,
  baseURL,
}, testInfo) => {
  test.setTimeout(45_000);
  const fixture = dashboardFixture(12);
  let activeStreams = 0;
  let peakStreams = 0;
  let summaries = 0;
  let boardSummaries = 0;
  const protocols = new Set<string>();
  const server = createServer(async (request, response) => {
    protocols.add(request.httpVersion);
    const pathname = new URL(request.url!, "http://127.0.0.1").pathname;
    if (pathname.startsWith("/api/auth/get-session")) {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(fixture.session));
    } else if (pathname.startsWith("/rpc/")) {
      const procedure = pathname.slice("/rpc/".length);
      if (procedure === "threads/subscribe") {
        activeStreams += 1;
        peakStreams = Math.max(peakStreams, activeStreams);
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        });
        response.write(": connected\n\n");
        response.on("close", () => {
          activeStreams -= 1;
        });
        return;
      }
      let body = "";
      for await (const chunk of request) body += chunk;
      if (procedure === "dashboard/now") summaries += 1;
      if (procedure === "board/view") boardSummaries += 1;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({ json: fixture.rpc(procedure, body ? JSON.parse(body).json : undefined) }),
      );
    } else {
      try {
        const upstream = await fetch(new URL(request.url!, baseURL));
        response.writeHead(upstream.status, {
          "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream",
        });
        response.end(Buffer.from(await upstream.arrayBuffer()));
      } catch {
        response.writeHead(502);
        response.end();
      }
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture listener");
  try {
    await page.clock.install();
    await page.goto(`http://127.0.0.1:${address.port}/app`);
    await expect(
      page.locator('[data-panel="now"]').getByRole("button", { name: "Allow once", exact: true }),
    ).toBeVisible();
    // Let every idle bot subscription start before trying to use the same origin again.
    await page.waitForTimeout(500);
    await page
      .locator('[data-panel="now"]')
      .getByRole("button", { name: "Allow once", exact: true })
      .click();
    await expect
      .poll(() => fixture.approvedInput, { timeout: 5_000 })
      .toMatchObject({ runId: "run", answer: "allow" });
    await expect(page.getByText("Nothing running", { exact: true })).toBeVisible();
    expect(peakStreams).toBeLessThanOrEqual(1);
    const beforeRefresh = summaries;
    await page.clock.runFor(15_001);
    await expect.poll(() => summaries).toBeGreaterThan(beforeRefresh);
    await page.goto(`http://127.0.0.1:${address.port}/app/board`);
    await expect(page.locator('[data-board-item="work-1"]')).toBeVisible();
    const beforeBoard = boardSummaries;
    await page.clock.runFor(15_001);
    await expect.poll(() => boardSummaries).toBeGreaterThan(beforeBoard);
    expect(peakStreams).toBeLessThanOrEqual(1);
    expect([...protocols]).toEqual(["1.1"]);
  } finally {
    await testInfo.attach("dashboard-http1-requests", {
      body: JSON.stringify({
        peakStreams,
        summaries,
        boardSummaries,
        answered: fixture.approvedInput !== undefined,
      }),
      contentType: "application/json",
    });
    await page.goto("about:blank");
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

import { createServer } from "node:http";
