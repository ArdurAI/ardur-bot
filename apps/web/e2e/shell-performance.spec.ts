import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CDPSession, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { installPerformanceFixture } from "./performance-fixture";

async function traceFrames(page: Page, name: string, action: () => Promise<void>) {
  await page.evaluate((label) => {
    const frame = () => {
      performance.mark(`perf:motion:${label}`);
      if (performance.getEntriesByName(`perf:motion:${label}:stop`).length === 0)
        requestAnimationFrame(frame);
      else performance.mark(`perf:motion:${label}:done`);
    };
    requestAnimationFrame(frame);
  }, name);
  try {
    await action();
  } finally {
    await page.evaluate(async (label) => {
      // Include the complete 200 ms exit transition after the interaction completes.
      await new Promise((resolve) => setTimeout(resolve, 300));
      performance.mark(`perf:motion:${label}:stop`);
    }, name);
  }
  await page.waitForFunction(
    (label) => performance.getEntriesByName(`perf:motion:${label}:done`).length > 0,
    name,
  );
}
async function stopTrace(cdp: CDPSession) {
  const completed = new Promise<{ stream?: string }>((resolve) =>
    cdp.once("Tracing.tracingComplete", resolve),
  );
  await cdp.send("Tracing.end");
  const { stream } = await completed;
  if (!stream) throw new Error("Chromium did not return a timeline stream.");
  let json = "";
  for (;;) {
    const part = await cdp.send("IO.read", { handle: stream });
    json += part.base64Encoded ? Buffer.from(part.data, "base64").toString() : part.data;
    if (part.eof) break;
  }
  await cdp.send("IO.close", { handle: stream });
  return json;
}

test("production shell startup, fake-provider first token, and three motions", async ({
  browser,
}, testInfo) => {
  const launches: number[] = [];
  const warnings: string[] = [];
  const tokens: number[] = [];
  for (let sample = 0; sample < 5; sample++) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    const page = await context.newPage();
    await installPerformanceFixture(page);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Tracing.start", {
      categories: "blink.user_timing,devtools.timeline,disabled-by-default-devtools.timeline.frame",
      transferMode: "ReturnAsStream",
    });
    try {
      await page.goto("http://127.0.0.1:55420/app/fixture-bot-0");
      await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
      await page.waitForFunction(
        () => performance.getEntriesByName("rk:renderer:shell-painted").length > 0,
      );
      launches.push(
        await page.evaluate(
          () => performance.getEntriesByName("rk:renderer:shell-painted")[0]!.startTime,
        ),
      );
      if (sample === 4) {
        await traceFrames(page, "panel-open", async () => {
          await page.getByTestId("bot-settings-trigger").click();
        });
        await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "settings");
        await page.screenshot({ path: testInfo.outputPath("side-panel.png") });
        await traceFrames(page, "panel-close", async () => {
          await page
            .getByTestId("side-panel")
            .getByRole("button", { name: "Close panel", exact: true })
            .click();
        });
        await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "closed");
        await traceFrames(page, "bot-switch", async () => {
          await page.getByTestId("bots-sidebar").getByText("Fixture B", { exact: true }).click();
        });
        await expect(page).toHaveURL(/fixture-bot-1/);
        await page.getByTestId("bots-sidebar").getByText("Fixture A", { exact: true }).click();
        await expect(page).toHaveURL(/fixture-bot-0/);
      }
      const composer = page.getByTestId("composer-bar").locator("textarea");
      await composer.fill("Hello");
      await traceFrames(page, "message-arrival", async () => {
        await composer.press("Enter");
        await expect(page.getByText("First fixture token", { exact: true })).toBeVisible();
        await page.waitForFunction(
          () => performance.getEntriesByName("perf:first-token").length > 0,
        );
      });
      await page.screenshot({ path: testInfo.outputPath("first-token.png") });
      const overhead = await page.evaluate(
        () =>
          performance.getEntriesByName("perf:first-token")[0]!.startTime -
          performance.getEntriesByName("perf:submit")[0]!.startTime,
      );
      tokens.push(overhead);
      testInfo.annotations.push({
        type: "fake-provider-first-token-ms",
        description: String(overhead),
      });
    } finally {
      const trace = await stopTrace(cdp);
      await testInfo.attach(`timeline-${sample}.json`, {
        body: trace,
        contentType: "application/json",
      });
      if (sample === 4) {
        const events = JSON.parse(trace).traceEvents as { name: string; ts: number; ph: string }[];
        for (const motion of ["panel-open", "panel-close", "bot-switch", "message-arrival"]) {
          const frames = events
            .filter((event) => event.name === `perf:motion:${motion}` && event.ph !== "e")
            .map((event) => event.ts / 1000)
            .sort((a, b) => a - b);
          if (frames.length < 2) {
            warnings.push(`Missing frame samples for ${motion}.`);
            continue;
          }
          const maxGap = Math.max(...frames.slice(1).map((time, index) => time - frames[index]!));
          const minimumFps = 1000 / maxGap;
          if (minimumFps < 50)
            warnings.push(
              `${motion}: slowest frame interval ${maxGap.toFixed(1)} ms (${minimumFps.toFixed(1)} fps), target 60, warning below 50.`,
            );
          testInfo.annotations.push({
            type: `motion-${motion}-fps`,
            description: minimumFps.toFixed(1),
          });
        }
      }
      await context.tracing.stop({ path: testInfo.outputPath(`launch-${sample}.zip`) });
      await context.close();
    }
  }
  const report = {
    kind: "browser-proxy",
    machine: {
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model,
      cores: os.cpus().length,
      browser: browser.version(),
    },
    metrics: {
      coldShellPaintMs: [...launches].sort((a, b) => a - b)[2]!,
      submitToFirstTokenMs: [...tokens].sort((a, b) => a - b)[2]!,
    },
    samples: launches,
    warnings,
  };
  const output = process.env.PERF_BROWSER_REPORT ?? "../../.context/performance/browser.json";
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  for (const warning of warnings) console.warn(`::warning title=Motion budget::${warning}`);
});

test("idle spaces polling waits at least five seconds between reads", async ({ page }) => {
  await installPerformanceFixture(page);
  const reads: number[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/rpc/spaces/list")) reads.push(Date.now());
  });
  await page.goto("http://127.0.0.1:55420/app/fixture-bot-0");
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  await expect.poll(() => reads.length, { timeout: 16000 }).toBeGreaterThanOrEqual(2);
  // Request dispatch and browser scheduling may vary by a few milliseconds.
  expect(reads.at(-1)! - reads.at(-2)!).toBeGreaterThanOrEqual(4900);
});

test("Board loads on navigation while the shell stays visible and supports direct links", async ({
  page,
}) => {
  await installPerformanceFixture(page);
  await page.route("**/rpc/board/workspaces", (route) =>
    route.fulfill({
      json: {
        json: {
          workspaces: [
            {
              id: "fixture-board",
              kind: "space",
              name: "Board",
              path: "/fixture/board",
              prefix: "board",
              enabled: true,
              initialized: true,
            },
          ],
          problem: null,
        },
      },
    }),
  );
  await page.route("**/rpc/board/snapshot", (route) =>
    route.fulfill({ json: { json: { items: [], readyIds: [], blockedIds: [] } } }),
  );
  const boardScript = /\/assets\/Board-[^/]+\.js$/;
  const requests: string[] = [];
  page.on("request", (request) => {
    if (boardScript.test(request.url())) requests.push(request.url());
  });
  let release: () => void = () => undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(boardScript, async (route) => {
    await pending;
    await route.continue();
  });
  try {
    await page.goto("/app/fixture-bot-0");
    await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
    expect(requests).toHaveLength(0);
    const loading = page.waitForRequest(boardScript);
    await page.getByRole("button", { name: "Board", exact: true }).click();
    await loading;
    await expect(page.getByTestId("bots-sidebar")).toBeVisible();
    await expect(page.locator("[data-board-column]")).toHaveCount(0);
    release();
    await expect(page).toHaveURL(/\/app\/board$/);
    await expect(page.locator("[data-board-column]")).toHaveCount(5);
    expect(requests).toHaveLength(1);
    await page.reload();
    await expect(page).toHaveURL(/\/app\/board$/);
    await expect(page.locator("[data-board-column]")).toHaveCount(5);
  } finally {
    release();
  }
});
