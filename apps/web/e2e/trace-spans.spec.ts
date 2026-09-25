import { readFile } from "node:fs/promises";
import type { ThreadSnapshot } from "@ardurbot/contracts";
import { expect, test } from "@playwright/test";
import { installPerformanceFixture, tokenEvent } from "./performance-fixture";

declare global {
  var __traceTestFrames: { count: () => number; tick: () => void };
}

test("committed streaming updates do not restart the pending two-frame paint observation", async ({
  page,
}) => {
  await page.addInitScript(() => {
    globalThis.__ardurTrace = { capacity: 128 };
  });
  await installPerformanceFixture(page, true, true);
  await page.goto("/app/fixture-bot-0");
  const composer = page.getByTestId("composer-bar").locator("textarea");
  await expect(composer).toBeVisible();
  await page.evaluate(() => {
    const frames = new Map<number, FrameRequestCallback>();
    let id = 0;
    window.requestAnimationFrame = (callback) => {
      frames.set(++id, callback);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      frames.delete(id);
    };
    globalThis.__traceTestFrames = {
      count: () => frames.size,
      tick: () => {
        const next = [...frames.values()];
        frames.clear();
        for (const callback of next) callback(performance.now());
      },
    };
  });
  await composer.fill("Hello");
  await composer.press("Enter");
  await page.waitForFunction(
    () =>
      globalThis.__ardurTrace?.text?.has("fixture-run") && globalThis.__traceTestFrames.count() > 0,
    undefined,
    { polling: 10 },
  );
  await page.evaluate(() => globalThis.__traceTestFrames.tick());
  await page.evaluate(
    (event) => window.dispatchEvent(new CustomEvent("fixture:product-event", { detail: event })),
    {
      ...tokenEvent,
      id: "helper-progress",
      runId: "fixture-helper",
      seq: 102,
      payload: { text: "Concurrent helper text", streaming: true },
    },
  );
  await expect(page.locator('[data-message-id="progress:fixture-helper"]')).toContainText(
    "Concurrent helper text",
  );
  await page.evaluate(() => globalThis.__traceTestFrames.tick());
  expect(
    await page.evaluate(() =>
      globalThis.__ardurTrace?.points?.some(
        (point) => point.traceId === "fixture-run" && point.boundary === "client.text.painted",
      ),
    ),
  ).toBe(true);
});

for (const overflow of ["auto", "hidden", "clip"]) {
  test(`paint excludes text clipped by a nested overflow ${overflow} ancestor`, async ({
    page,
  }) => {
    const manifest = JSON.parse(
      await readFile(new URL("../dist/.vite/manifest.json", import.meta.url), "utf8"),
    );
    const moduleUrl = `/${manifest["src/lib/scoreboard-trace.ts"].file}`;
    // Isolate geometry from the Shell's asynchronous bootstrap commits. The imported collector
    // is still the production build; a separate test above exercises its real React lifecycle.
    await page.route("**/trace-fixture", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><html><body></body></html>",
      }),
    );
    await page.goto("/trace-fixture");
    const result = await page.evaluate(
      async ({ moduleUrl, overflow }) => {
        const { traceRpc, paintThreadTrace } = await import(moduleUrl);
        globalThis.__ardurTrace = { capacity: 32 };
        const container = document.createElement("div");
        container.style.cssText = `position:fixed;top:200px;left:200px;width:200px;height:60px;overflow:${overflow}`;
        const wrapper = document.createElement("div");
        const message = document.createElement("div");
        message.dataset.messageId = "clipped-message";
        message.textContent = "Synthetic text";
        message.style.cssText = "position:relative;top:-80px;width:100px;height:20px";
        wrapper.append(message);
        container.append(wrapper);
        document.body.append(container);
        const rect = message.getBoundingClientRect();
        const outsideScrollport =
          rect.bottom <= container.getBoundingClientRect().top && rect.top > 0;
        const snapshot: ThreadSnapshot = {
          threadId: "clip-thread",
          cursor: 20,
          olderCursor: null,
          run: null,
          messages: [
            {
              id: "clipped-message",
              threadId: "clip-thread",
              runId: "clip-run",
              seq: 20,
              role: "bot",
              blocks: [{ kind: "text", text: "Synthetic text" }],
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
        };
        const stream = await traceRpc(["threads", "subscribe"], async () =>
          (async function* () {
            yield {
              id: "clip-event",
              threadId: "clip-thread",
              runId: "clip-run",
              botId: "clip-bot",
              spaceId: "clip-space",
              seq: 20,
              type: "thread.message.created",
              payload: { messageId: "clipped-message", role: "bot" },
              createdAt: "2026-01-01T00:00:00Z",
            };
          })(),
        );
        for await (const _ of stream) {
          /* Consume through the production transport hook. */
        }
        const paint = async () => {
          paintThreadTrace(snapshot);
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
          return globalThis.__ardurTrace!.points!.filter(
            (point) => point.boundary === "client.text.painted",
          ).length;
        };
        const clipped = await paint();
        message.style.top = "10px";
        const visible = await paint();
        container.remove();
        return { outsideScrollport, clipped, visible };
      },
      { moduleUrl, overflow },
    );
    expect(result).toEqual({ outsideScrollport: true, clipped: 0, visible: 1 });
  });
}

test("production renderer correlates RPC submission, streamed text and terminal paint", async ({
  page,
}, info) => {
  await page.addInitScript(() => {
    globalThis.__ardurTrace = { capacity: 128 };
  });
  await installPerformanceFixture(page, true);
  await page.goto("/app/fixture-bot-0");
  const composer = page.getByTestId("composer-bar").locator("textarea");
  await composer.fill("Hello");
  await composer.press("Enter");
  await page.waitForFunction(() =>
    globalThis.__ardurTrace?.points?.some((p) => p.boundary === "client.terminal.painted"),
  );
  const points = await page.evaluate(() => globalThis.__ardurTrace!.points!);
  const boundaries = points.filter((p) => p.traceId === "fixture-run").map((p) => p.boundary);
  expect(boundaries).toEqual(
    expect.arrayContaining([
      "client.submitted",
      "client.acknowledged",
      "client.received",
      "client.text.painted",
      "client.terminal.painted",
    ]),
  );
  expect(points.find((p) => p.boundary === "client.text.painted")!.at).toBeGreaterThanOrEqual(
    points.find((p) => p.boundary === "client.submitted")!.at,
  );
  expect(await page.evaluate(() => globalThis.__ardurTrace!.dropped)).toBe(0);
  await info.attach("renderer-trace.json", {
    body: JSON.stringify({
      kind: "production-renderer-with-synthetic-transport",
      packaged: false,
      points,
    }),
    contentType: "application/json",
  });
  await page.screenshot({ path: info.outputPath("terminal-painted.png") });
});
