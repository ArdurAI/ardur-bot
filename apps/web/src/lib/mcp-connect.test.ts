import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectMcpOauth, waitForMcpOauth } from "./mcp-connect";

const begin = vi.hoisted(() => vi.fn());
vi.mock("./rpc", () => ({ rpc: { mcp: { oauth: { begin } } } }));

let channel: { onmessage?: (event: { data: unknown }) => void; close: ReturnType<typeof vi.fn> };
let popup: { closed: boolean; close: ReturnType<typeof vi.fn>; location: { href: string } };
beforeEach(() => {
  vi.useFakeTimers();
  begin.mockReset();
  popup = { closed: false, close: vi.fn(), location: { href: "about:blank" } };
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      onmessage?: (event: { data: unknown }) => void;
      close = vi.fn();
      constructor() {
        channel = this;
      }
    },
  );
  vi.stubGlobal("window", {
    open: vi.fn(() => popup),
    location: { origin: "https://app.example.test", assign: vi.fn() },
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("MCP browser consent", () => {
  it("reuses the OAuth endpoint and only accepts its matching callback", async () => {
    begin.mockResolvedValue({
      status: "authorization_required",
      authorizationUrl: "https://auth.example.test/authorize",
      sessionId: "ours",
    });
    const result = connectMcpOauth("connection");
    await vi.advanceTimersByTimeAsync(0);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    channel.onmessage?.({ data: { type: "mcp-oauth-complete", sessionId: "other" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    channel.onmessage?.({ data: { type: "mcp-oauth-complete", sessionId: "ours" } });
    expect(await result).toBe("connected");
    expect(begin).toHaveBeenCalledWith({
      serverId: "connection",
      redirectUri: "https://app.example.test/api/oauth/done",
    });
    expect(channel.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps waiting after a provider severs the popup opener", async () => {
    const result = waitForMcpOauth(
      "https://auth.example.test/authorize",
      popup as unknown as Window,
      "ours",
    );
    expect(popup.location.href).toBe("https://auth.example.test/authorize");
    popup.closed = true;
    await vi.advanceTimersByTimeAsync(500);
    channel.onmessage?.({ data: { type: "mcp-oauth-complete", sessionId: "ours" } });
    expect(await result).toBe("connected");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps the server session alive when popup blocking requires full-page navigation", async () => {
    expect(await waitForMcpOauth("https://auth.example.test/authorize", null)).toBe(
      "authorization_not_requested",
    );
    expect(window.location.assign).toHaveBeenCalledWith("https://auth.example.test/authorize");
  });
  it("cancels a consent window that times out", async () => {
    const result = waitForMcpOauth("https://auth.example.test/authorize");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(await result).toBe("cancelled");
    expect(popup.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
