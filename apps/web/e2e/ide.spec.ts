import {
  DEFAULT_USER_PREFERENCES,
  decodeTerminalFrame,
  encodeTerminalFrame,
} from "@ardurbot/contracts";
import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";
import { bots, installPerformanceFixture } from "./performance-fixture";

/** Entirely offline: browser, real editor and terminal UI, deterministic RPC and PTY fixtures. */
test("inbuilt IDE opens, edits, saves, hands off selections and binds the shared terminal", async ({
  page,
}, testInfo) => {
  await installPerformanceFixture(page);
  const files = new Map([
    ["src/main.ts", "const answer = 41;\nconsole.log(answer);\n"],
    ["large.ts", "const value = 'preview';\n".repeat(8_000)],
    ["read-only.txt", "preview"],
    ["binary.bin", ""],
  ]);
  let sent: { text: string; botId: string } | undefined;
  let ticket: { computerId: string; workspace: string } | undefined;
  const roots = [
    {
      id: "host-project",
      kind: "host",
      name: "Project",
      path: "/workspace/project",
      computerId: null,
      botId: null,
    },
    {
      id: "sandbox-computer",
      kind: "sandbox",
      name: "Sandbox",
      path: "/",
      computerId: "computer",
      botId: bots[0]!.id,
    },
  ];
  await page.route("**/rpc/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    const input =
      request.postDataJSON()?.json ?? JSON.parse(url.searchParams.get("data") ?? "{}").json ?? {};
    const operation = url.pathname.slice(5);
    let result: unknown;
    if (operation === "preferences/get") result = DEFAULT_USER_PREFERENCES;
    else if (operation === "ide/roots") result = roots;
    else if (operation === "bots/list") result = bots;
    else if (operation === "ide/list")
      result =
        input.path === "src"
          ? [{ path: "src/main.ts", kind: "file", size: 40 }]
          : [
              { path: "src", kind: "dir", size: 0 },
              ...["large.ts", "read-only.txt", "binary.bin"].map((path) => ({
                path,
                kind: "file",
                size: files.get(path)!.length,
              })),
            ];
    else if (operation === "ide/read")
      result = {
        path: input.path,
        content: files.get(input.path),
        size: input.path === "read-only.txt" ? 3_000_000 : files.get(input.path)!.length,
        binary: input.path === "binary.bin",
        readOnly: input.path === "read-only.txt",
        version: "a".repeat(64),
      };
    else if (operation === "ide/save") {
      files.set(input.path, input.content);
      result = { saved: true, approvalRequired: false, version: "b".repeat(64) };
    } else if (operation === "ide/changes")
      result = {
        items: sent
          ? [
              {
                id: "change",
                path: "src/main.ts",
                before: "const answer = 41;",
                after: "const answer = 42;",
                botId: bots[0]!.id,
                runId: "run",
                createdAt: new Date().toISOString(),
                source: "tool",
              },
            ]
          : [],
        nextCursor: null,
      };
    else if (operation === "threads/send") {
      sent = input;
      result = { runId: "run", taskId: "task", seq: 1 };
    } else if (operation === "computer/status")
      result = {
        computerId: "computer",
        state: "running",
        kind: "docker",
        controlHolder: "user",
        controlBotId: bots[0]!.id,
      };
    else if (operation === "terminal/available") result = { available: true };
    else if (operation === "terminal/ticket") {
      ticket = input;
      result = {
        sessionId: "terminal-session",
        ticket: "fixture-ticket",
        path: "/api/terminal/socket",
      };
    } else if (operation === "terminal/close") result = { ok: true };
    else return route.fallback();
    await route.fulfill({ json: { json: result } });
  });
  const commands: string[] = [];
  let outputSeq = 0;
  await page.routeWebSocket("**/api/terminal/socket", (socket) =>
    socket.onMessage((message) => {
      if (typeof message !== "string") {
        const input = new TextDecoder().decode(decodeTerminalFrame(new Uint8Array(message)).bytes);
        commands.push(input);
        const output = input === "\r" ? "\r\n/home/ardurbot\r\n$ " : input;
        socket.send(
          Buffer.from(encodeTerminalFrame(++outputSeq, new TextEncoder().encode(output))),
        );
        return;
      }
      const frame = JSON.parse(message);
      if (frame.type === "connect") {
        socket.send(JSON.stringify({ type: "ready", inputSeq: 0 }));
        socket.send(Buffer.from(encodeTerminalFrame(++outputSeq, new TextEncoder().encode("$ "))));
      }
      if (frame.type === "input") {
        commands.push(frame.data);
        socket.send(JSON.stringify({ type: "input-ack", seq: frame.seq }));
      }
    }),
  );
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      if (
        document.querySelector('[data-ide-editor][aria-label="large.ts"]') &&
        !performance.getEntriesByName("ide:large:paint").length
      ) {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => performance.mark("ide:large:paint")),
        );
      }
    });
    document.addEventListener(
      "DOMContentLoaded",
      () => observer.observe(document.documentElement, { childList: true, subtree: true }),
      { once: true },
    );
  });
  // Bots must render without fetching the editor or its language parsers.
  await page.goto("/app/fixture-bot-0");
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  expect(
    await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .some((entry) => /\/(?:IdePage|ide-codemirror|terminal-session|diff)-/.test(entry.name)),
    ),
  ).toBe(false);
  await page.goto("/app/ide");
  await expect(page.getByRole("heading", { name: "IDE", exact: true })).toBeVisible();
  const divider = page.getByRole("separator", { name: "IDE", exact: true });
  const bounds = (await divider.boundingBox())!;
  await page.mouse.move(bounds.x + 2, bounds.y + 40);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 66, bounds.y + 40);
  await page.mouse.up();
  await expect(divider).toHaveAttribute("aria-valuenow", "27");
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem("ardurbot:ide-layout")!).tree),
  ).toBeGreaterThan(26);
  await page.getByRole("button", { name: "large.ts", exact: true }).click();
  await expect(page.locator('[data-ide-editor][aria-label="large.ts"]')).toBeVisible();
  await page.waitForFunction(() => performance.getEntriesByName("ide:large:paint").length > 0);
  const renderMs = await page.evaluate(() => {
    const read = performance
      .getEntriesByType("resource")
      .filter((entry) => entry.name.includes("/rpc/ide/read"))
      .at(-1) as PerformanceResourceTiming;
    return performance.getEntriesByName("ide:large:paint")[0]!.startTime - read.responseEnd;
  });
  testInfo.annotations.push({ type: "192-KB-read-to-paint-ms", description: renderMs.toFixed(1) });
  expect(renderMs).toBeLessThan(150);
  await page.getByRole("button", { name: "src", exact: true }).click();
  await page.getByRole("button", { name: "main.ts", exact: true }).click();
  const editor = page.locator('[data-ide-editor][aria-label="src/main.ts"]');
  await editor.fill("const answer = 42;\nconsole.log(answer);\n");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("link", { name: "Bots", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/ide$/);
  await expect(editor).toContainText("const answer = 42;");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByRole("status")).toHaveText("Saved");
  expect(files.get("src/main.ts")).toContain("42");
  await editor.focus();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("Shift+End");
  await page.keyboard.press("ControlOrMeta+Shift+a");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("textbox", { name: "Ask a bot", exact: true }).fill("Explain this");
  await page.getByRole("dialog").getByRole("button", { name: "Ask a bot", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(sent).toMatchObject({
    botId: bots[0]!.id,
    text: "Explain this\n\n/workspace/project/src/main.ts:1-1\n\nconst answer = 42;",
  });
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.getByRole("tab", { name: "Changes", exact: true }).click();
  await page
    .getByRole("region", { name: "Changes" })
    .getByRole("button", { name: "src/main.ts" })
    .click();
  await expect(page.getByTestId("ide-diff")).toContainText("41");
  await expect(page.getByTestId("ide-diff")).toContainText("42");
  await captureScreenshot(page, testInfo, "ide-changes");
  await page.getByRole("tab", { name: "main.ts", exact: true }).click();
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await captureScreenshot(page, testInfo, "ide-editor-light");
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await captureScreenshot(page, testInfo, "ide-editor-dark");
  await page
    .getByRole("combobox", { name: "Computer", exact: true })
    .selectOption("sandbox-computer");
  await page.keyboard.press("ControlOrMeta+Backquote");
  await expect(page.getByRole("region", { name: "Terminal", exact: true })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Terminal", exact: true }).getByRole("status"),
  ).toHaveCount(0);
  expect(ticket).toMatchObject({ computerId: "computer", workspace: "computer" });
  const terminal = page.getByRole("textbox", { name: "Terminal", exact: true });
  await terminal.focus();
  await page.keyboard.type("pwd");
  await page.keyboard.press("Enter");
  await expect.poll(() => commands.join("")).toContain("pwd");
  await captureScreenshot(page, testInfo, "ide-terminal");

  // Traverse entries made by BrowserRouter, rather than reloading the document.
  await page.getByRole("link", { name: "Bots", exact: true }).click();
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  await page.goBack();
  await expect(page.getByRole("heading", { name: "IDE", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "src", exact: true }).click();
  await page.getByRole("button", { name: "main.ts", exact: true }).click();
  await editor.fill("unsaved buffer");
  await expect(page.getByRole("img", { name: "Unsaved changes", exact: true })).toBeVisible();
  const index = await page.evaluate(() => window.history.state.idx);
  const length = await page.evaluate(() => window.history.length);
  for (let attempt = 0; attempt < 2; attempt++) {
    const dialogReady = page.waitForEvent("dialog", { timeout: 10_000 });
    await page.evaluate(() => window.history.forward());
    const dialog = await dialogReady;
    expect(dialog.type()).toBe("confirm");
    expect(dialog.message()).toBe("Unsaved changes");
    await dialog.dismiss();
    await expect.poll(() => page.evaluate(() => window.history.state.idx)).toBe(index);
    await expect(editor).toHaveText("unsaved buffer");
    expect(await page.evaluate(() => window.history.length)).toBe(length);
  }
  page.once("dialog", (dialog) => dialog.accept());
  await page.evaluate(() => window.history.forward());
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
});
