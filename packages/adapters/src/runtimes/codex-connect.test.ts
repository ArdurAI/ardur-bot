import { describe, expect, it, vi } from "vitest";
import type { CodexRpc } from "./codex-app-server-runtime.js";
import { CodexConnections } from "./codex-connect.js";
import { RuntimeQueue } from "./native-process.js";

it("starts vendor-managed ChatGPT login and returns only the scoped connect-card data", async () => {
  const events = new RuntimeQueue<{ method: string; params: Record<string, unknown> }>();
  const request = vi.fn(async () => ({
    type: "chatgpt",
    loginId: "login",
    authUrl: "https://auth.openai.com/authorize?state=test",
  }));
  const close = vi.fn(async () => undefined);
  const connections = new CodexConnections(
    async () => ({ request, events, close }) as unknown as CodexRpc,
  );
  const card = await connections.begin("owner");
  expect(request).toHaveBeenCalledWith("account/login/start", { type: "chatgpt" });
  expect(card).toEqual({
    mode: "auth-url",
    provider: "codex-app-server",
    loginId: "login",
    verificationUri: "https://auth.openai.com/authorize?state=test",
    expiresInSeconds: 300,
  });
  expect(() => connections.status("another-user", "login")).toThrow();
  events.push({ method: "account/login/completed", params: { loginId: "login", success: true } });
  await vi.waitFor(() => expect(connections.status("owner", "login")).toEqual({ status: "ready" }));
  await connections.cancel("owner", "login");
  expect(close).toHaveBeenCalled();
});

describe("untrusted login responses", () => {
  it("refuses non-vendor authorization URLs", async () => {
    const close = vi.fn();
    const rpc = {
      request: async () => ({ loginId: "login", authUrl: "https://example.test/steal" }),
      close,
    } as unknown as CodexRpc;
    await expect(new CodexConnections(async () => rpc).begin("owner")).rejects.toThrow(
      "unavailable",
    );
    expect(close).toHaveBeenCalledOnce();
  });
});
