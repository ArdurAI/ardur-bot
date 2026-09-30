import type { ThreadSnapshot } from "@ardurbot/contracts";
import type { EvidenceRunSummary } from "@ardurbot/contracts/evidence";
import { expect, test } from "@playwright/test";
import { dashboardFixture } from "./dashboard-fixture";
import { captureScreenshot } from "./helpers";

test("owner recording and sealed run evidence", async ({ page }, testInfo) => {
  const fixture = dashboardFixture();
  let enabled = false;
  let summaries = 0;
  const summary: EvidenceRunSummary = {
    sessionId: "run",
    state: "verified",
    sealed: true,
    gapCount: 0,
    failureCodes: [],
    recordedAt: "2026-09-29T12:00:00Z",
    captureLevel: "decisions",
    decisions: { allowed: 2, denied: 1, asked: 1, recorded: 4 },
    evidence: {
      bundleId: "run",
      encrypted: false,
      keyId: "fixture-public-key",
      keyRevision: 1,
      revocationListRevision: "",
      verifierUrl: "https://ardur.ai/docs/governance/",
    },
    gates: { spend: null, risks: [] },
  };
  await page.route("**/api/auth/get-session*", (route) => route.fulfill({ json: fixture.session }));
  await page.route("**/rpc/**", async (route) => {
    const procedure = new URL(route.request().url()).pathname.slice("/rpc/".length);
    const input = route.request().postDataJSON()?.json;
    if (procedure === "threads/subscribe")
      return route.fulfill({ contentType: "text/event-stream", body: "" });
    let result = fixture.rpc(procedure, input);
    if (procedure === "features/set") enabled = input.state === "enabled";
    if (procedure === "features/list" || procedure === "features/set")
      result =
        procedure === "features/list"
          ? [{ feature: "governance", state: enabled ? "enabled" : "disabled", canManage: true }]
          : { feature: "governance", state: enabled ? "enabled" : "disabled" };
    if (procedure === "evidence/runSummary") {
      summaries++;
      result = summary;
    }
    if (procedure === "threads/get") {
      const snapshot = result as ThreadSnapshot;
      result = {
        ...snapshot,
        run: null,
        messages: [
          {
            ...snapshot.messages[0],
            blocks: [{ kind: "text", text: "Checked the draft and recorded the decisions." }],
          },
        ],
      };
    }
    await route.fulfill({ json: { json: result } });
  });
  await page.goto("/app?view=dashboard");
  const governance = page.locator('[data-panel="governance"]');
  const control = governance.getByRole("switch", { name: "Record evidence of bot decisions" });
  await expect(control).not.toBeChecked();
  await control.click();
  await expect(control).toBeChecked();
  expect(enabled).toBe(true);
  expect(summaries).toBe(0);
  await captureScreenshot(page, testInfo, "evidence-recording-control");
  await page.goto("/app/bot");
  await expect(page.locator('[data-evidence-state="verified"]')).toHaveText("Verified");
  const message = page.locator('[data-message-id="message"]');
  await message.hover();
  await message.getByRole("button", { name: "More", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Download evidence" })).toBeVisible();
  await captureScreenshot(page, testInfo, "evidence-verified-run");
});
