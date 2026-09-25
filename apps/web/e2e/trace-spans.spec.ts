import { expect, test } from "@playwright/test";
import { installPerformanceFixture } from "./performance-fixture";

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
