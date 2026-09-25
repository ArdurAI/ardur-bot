import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectMcpOauth, waitForMcpOauth } from "./mcp-connect";

const begin = vi.hoisted(() => vi.fn());
const list = vi.hoisted(() => vi.fn(async (): Promise<unknown[]> => []));
vi.mock("./rpc", () => ({ rpc: { mcp: { oauth: { begin }, servers: { list } } } }));

let channel: { onmessage?: (event: { data: unknown }) => void; close: ReturnType<typeof vi.fn> };
let popup: { closed: boolean; close: ReturnType<typeof vi.fn>; location: { href: string } };
beforeEach(() => {
  vi.useFakeTimers();
  begin.mockReset();
  list.mockReset().mockResolvedValue([]);
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
  it("finishes only after the API records the sign-in's outcome", async () => {
    begin.mockResolvedValue({
      status: "authorization_required",
      authorizationUrl: "https://auth.example.test/authorize",
      sessionId: "ours",
    });
    const server = { id: "connection", oauthStatus: "connected", connectionState: "not-connected" };
    list.mockImplementation(async () => [server]);
    const result = connectMcpOauth("connection");
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(settled).toBe(false);
    server.connectionState = "connected";
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBe("connected");
  });
  it("ends a declined sign-in as soon as the API records it", async () => {
    begin.mockResolvedValue({
      status: "authorization_required",
      authorizationUrl: "https://auth.example.test/authorize",
      sessionId: "ours",
    });
    list.mockResolvedValue([
      { id: "connection", oauthStatus: "reconnect", connectionState: "needs-sign-in" },
    ]);
    const result = connectMcpOauth("connection");
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBe("cancelled");
    expect(popup.close).toHaveBeenCalledOnce();
  });
  it("reports discovery-failed instead of a completed sign-in", async () => {
    begin.mockResolvedValue({
      status: "authorization_required",
      authorizationUrl: "https://auth.example.test/authorize",
      sessionId: "ours",
    });
    list.mockResolvedValue([
      {
        id: "connection",
        oauthStatus: "connected",
        connectionState: "discovery-failed",
        lastError: "Could not reach this integration. Try again.",
      },
    ]);
    const result = connectMcpOauth("connection");
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBe("discovery-failed");
    expect(popup.close).toHaveBeenCalledOnce();
  });
});
