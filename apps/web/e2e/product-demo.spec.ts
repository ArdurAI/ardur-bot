// Runs only through the isolated fake/scripted harness; no live prerequisite is replaced silently.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ModelCredential, ThreadMessage, ThreadSnapshot } from "@ardurbot/contracts";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@ardurbot/contracts";
import { expect, test } from "@playwright/test";
import type {
  ProductDemoObservation,
  ProductDemoStepId,
} from "../../../packages/testkit/src/product-demo-report";
import {
  ProductDemoRecorder,
  writeProductDemoReport,
} from "../../../packages/testkit/src/product-demo-report";
import { completeOnboarding, createNamedBot, openUserSettings, rpc, signup } from "./helpers";

test("records the fixed seven-step product demo without promoting missing prerequisites", async ({
  page,
}, testInfo) => {
  if (
    process.env.SANDBOX_PROVIDER !== "fake" ||
    process.env.AGENT_RUNTIME !== "scripted" ||
    !process.env.PRODUCT_DEMO_BUILD_REVISION ||
    !process.env.PRODUCT_DEMO_REPORT_DIR ||
    !["0", "1"].includes(process.env.PRODUCT_DEMO_BUILD_DIRTY ?? "")
  )
    throw new Error(
      "Product demo requires the isolated fake/scripted harness and build provenance",
    );
  const output = process.env.PRODUCT_DEMO_REPORT_DIR;
  await mkdir(path.join(output, "screenshots"), { recursive: true, mode: 0o700 });
  const recorder = new ProductDemoRecorder({
    mode: "scripted",
    buildRevision: process.env.PRODUCT_DEMO_BUILD_REVISION,
    buildDirty: process.env.PRODUCT_DEMO_BUILD_DIRTY === "1",
  });
  const screenshot = async (id: string) => {
    const file = path.join(output, "screenshots", `${id}.png`);
    await page.screenshot({ path: file, animations: "disabled", caret: "hide", fullPage: true });
    await testInfo.attach(`product-demo-${id}`, { path: file, contentType: "image/png" });
    return `screenshots/${id}.png`;
  };
  const unavailable = async (): Promise<never> => {
    throw new Error("Unavailable demo prerequisite was executed");
  };
  let failure: unknown;
  const runStep = (id: ProductDemoStepId, action: () => Promise<ProductDemoObservation>) =>
    recorder.step(id, async () => {
      try {
        return await action();
      } catch (error) {
        failure ??= error;
        throw error;
      }
    });
  await runStep("models", async () => {
    await signup(page, `product-demo-${Date.now()}@example.test`, "password12", "Product demo");
    await completeOnboarding(page);
    await rpc(page, "models/connect", {
      provider: OPENAI_COMPATIBLE_PROVIDER_ID,
      modelId: "demo-fixture",
      baseUrl: "http://127.0.0.1:29999/v1",
      label: "Demo fixture",
      contextWindow: 65536,
    });
    await rpc(page, "models/setDefault", {
      provider: OPENAI_COMPATIBLE_PROVIDER_ID,
      modelId: "demo-fixture",
    });
    const credential = (await rpc<ModelCredential[]>(page, "models/credentials", {})).find(
      (row) => row.provider === OPENAI_COMPATIBLE_PROVIDER_ID,
    );
    expect(credential?.contextWindow).toBe(65536);
    expect(credential?.contextWindowSource).toBe("metadata");
    await page.reload();
    await openUserSettings(page, "models");
    await page.getByPlaceholder("Search providers").fill("compatible");
    await page.getByRole("button", { name: /OpenAI-compatible/ }).click();
    await page.locator("summary", { hasText: /^Advanced$/ }).click();
    await expect(page.getByLabel("Context limit", { exact: true })).toHaveValue("65536");
    return { screenshot: await screenshot("models"), evidence: "app-api" };
  });
  // A fake sandbox is not This computer; scripted output is not a native-runtime qualification.
  await recorder.step("default-reply", unavailable, "host-computer");
  await recorder.step("native-reply", unavailable, "native-runtime");
  await recorder.step("draft-pr", unavailable, "github");
  await recorder.step("chief-summary", unavailable, "integration");
  await recorder.step("workspace", unavailable, "not-executed");
  await runStep("room", async () => {
    const first = await createNamedBot(page, "Demo first");
    const second = await createNamedBot(page, "Demo second");
    const group = await rpc<{ id: string }>(page, "groups/create", {
      name: "Demo room",
      botIds: [first, second],
    });
    await page.goto(`/app/g/${group.id}`);
    const replies: ThreadMessage[] = [];
    for (const [botId, name] of [
      [first, "Demo first"],
      [second, "Demo second"],
    ] as const) {
      await rpc(page, "threads/send", { groupId: group.id, text: `@${name} say ready` });
      let reply: ThreadMessage | undefined;
      await expect
        .poll(async () => {
          const snapshot = await rpc<ThreadSnapshot>(page, "threads/get", {
            groupId: group.id,
          });
          reply = snapshot.messages.find(
            (message) =>
              message.role === "bot" &&
              message.botId === botId &&
              message.blocks.some((block) => block.kind === "text" && block.text?.trim()),
          );
          return Boolean(reply);
        })
        .toBe(true);
      replies.push(reply!);
      const text = reply!.blocks.find((block) => block.kind === "text" && block.text.trim());
      expect(text?.kind).toBe("text");
      if (text?.kind !== "text") throw new Error("Missing demo reply text");
      await expect(page.getByText(text.text, { exact: false }).first()).toBeVisible();
    }
    const gap = Date.parse(replies[1]!.createdAt) - Date.parse(replies[0]!.createdAt);
    expect(gap).toBeGreaterThanOrEqual(0);
    return { screenshot: await screenshot("room"), evidence: "app-api", replyGapMs: gap };
  });
  const file = path.join(output, "product-demo.json");
  await writeProductDemoReport(file, recorder);
  await testInfo.attach("product-demo", { path: file, contentType: "application/json" });
  if (failure) throw failure;
  expect(recorder.report().steps.filter((row) => row.result === "failed")).toEqual([]);
});
