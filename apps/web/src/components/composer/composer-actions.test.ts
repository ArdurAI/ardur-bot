import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ restart: vi.fn(), remember: vi.fn(), summary: vi.fn() }));
vi.mock("../../lib/rpc", () => ({
  rpc: {
    threads: { restart: fake.restart },
    memory: { remember: fake.remember },
    usage: { summary: fake.summary },
  },
}));
vi.mock("@lingui/core/macro", () => ({ t: (parts: TemplateStringsArray) => parts.join("") }));

import { runComposerAction } from "./composer-actions";

function context() {
  return {
    botId: "bot",
    onRefresh: vi.fn(),
    onStop: vi.fn(),
    onRoutines: vi.fn(),
    onModel: vi.fn(),
    onChatSettings: vi.fn(),
    onSettings: vi.fn(),
    onUsage: vi.fn(),
    onError: vi.fn(),
  };
}
beforeEach(() => vi.clearAllMocks());
describe("composer action dispatch", () => {
  it("starts fresh context through restart and keeps the bot", async () => {
    const ctx = context();
    await runComposerAction("new", undefined, ctx);
    expect(fake.restart).toHaveBeenCalledWith({ botId: "bot" });
    expect(ctx.onRefresh).toHaveBeenCalledWith("bot");
  });
  it("saves /remember through the memory RPC without sending an agent run", async () => {
    await runComposerAction("remember", "Keep the source links", context());
    expect(fake.remember).toHaveBeenCalledWith({
      botId: "bot",
      text: "Keep the source links",
      nonce: expect.any(String),
    });
  });
  it.each([
    ["stop", "onStop"],
    ["routine", "onRoutines"],
    ["model", "onModel"],
    ["chat-settings", "onChatSettings"],
  ] as const)("dispatches /%s immediately", async (action, callback) => {
    const ctx = context();
    await runComposerAction(action, undefined, ctx);
    expect(ctx[callback]).toHaveBeenCalledOnce();
  });
  it("preserves both account settings destinations", async () => {
    const ctx = context();
    await runComposerAction("settings", undefined, ctx);
    expect(ctx.onSettings).toHaveBeenCalledWith("general");
    await runComposerAction("settings-usage", undefined, ctx);
    expect(ctx.onSettings).toHaveBeenCalledWith("usage");
    expect(fake.summary).toHaveBeenCalledOnce();
  });
  it("uses a sentence on failed memory writes", async () => {
    fake.remember.mockRejectedValueOnce(new Error("private backend detail"));
    const ctx = context();
    await runComposerAction("remember", "a note", ctx);
    expect(ctx.onError).toHaveBeenCalledWith("Could not save memory");
  });
});
