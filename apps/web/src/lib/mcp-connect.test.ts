import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectMcpOauth, waitForMcpOauth } from "./mcp-connect";

const begin = vi.hoisted(() => vi.fn());
const cancel = vi.hoisted(() => vi.fn(async () => ({ ok: true as const })));
const list = vi.hoisted(() => vi.fn(async (): Promise<unknown[]> => []));
vi.mock("./rpc", () => ({
  rpc: { mcp: { oauth: { begin, cancel }, servers: { list } } },
}));

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
    list.mockResolvedValue([
      { id: "connection", connectionState: "connected", pendingOauthSessionId: null },
    ]);
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
  it("treats a consent window that times out as unfinished sign-in", async () => {
    const result = waitForMcpOauth("https://auth.example.test/authorize");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(await result).toBe("needs-sign-in");
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
    const server = {
      id: "connection",
      oauthStatus: "reconnect",
      connectionState: "cancelled",
      revision: 1,
    };
    list.mockImplementation(async () => [{ ...server }]);
    const result = connectMcpOauth("connection");
    await vi.advanceTimersByTimeAsync(0);
    server.revision = 2;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBe("cancelled");
    expect(popup.close).toHaveBeenCalledOnce();
  });
  it("reports an unfinished sign-in separately from a decline", async () => {
    begin.mockResolvedValue({
      status: "authorization_required",
      authorizationUrl: "https://auth.example.test/authorize",
      sessionId: "ours",
    });
    const server = {
      id: "connection",
      oauthStatus: "reconnect",
      connectionState: "needs-sign-in",
      revision: 1,
    };
    list.mockImplementation(async () => [{ ...server }]);
    const result = connectMcpOauth("connection");
    await vi.advanceTimersByTimeAsync(0);
    server.revision = 2;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBe("needs-sign-in");
  });
  it("does not resolve a re-authorization when the token is stored, only after discovery clears the session", async () => {
    begin.mockResolvedValue({
      status: "authorization_required",
      authorizationUrl: "https://auth.example.test/authorize",
      sessionId: "ours",
    });
    const server = {
      id: "connection",
      connectionState: "connected",
      revision: 4,
      pendingOauthSessionId: "ours" as string | null,
      lastError: null as string | null,
    };
    list.mockImplementation(async () => [server]);
    const result = connectMcpOauth("connection");
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(settled).toBe(false);
    server.revision = 5;
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toBe(false);
    server.pendingOauthSessionId = null;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBe("connected");
  });
  it("reports a failed re-authorization after discovery while the connection stays recorded", async () => {
    begin.mockResolvedValue({
      status: "authorization_required",
      authorizationUrl: "https://auth.example.test/authorize",
      sessionId: "ours",
    });
    const server = {
      id: "connection",
      connectionState: "connected",
      revision: 5,
      pendingOauthSessionId: "ours" as string | null,
      lastError: null as string | null,
    };
    list.mockImplementation(async () => [server]);
    const result = connectMcpOauth("connection");
    let settled: string | null = null;
    void result.then((value) => {
      settled = value;
    });
    server.revision = 6;
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toBeNull();
    server.pendingOauthSessionId = null;
    server.lastError = "Could not reach this integration. Try again.";
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toBe("sign-in-failed");
    await result;
  });
  it("does not let a replaced window resolve the newer attempt", async () => {
    begin.mockResolvedValue({
      status: "authorization_required",
      authorizationUrl: "https://auth.example.test/authorize",
      sessionId: "ours",
    });
    const server = {
      id: "connection",
      connectionState: "not-connected",
      revision: 4,
      pendingOauthSessionId: "newer",
    };
    list.mockImplementation(async () => [server]);
    const result = connectMcpOauth("connection");
    let settled: string | null = null;
    void result.then((value) => {
      settled = value;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toBe("replaced");
  });
  it("does not resolve the newer attempt when an older decline is recorded beside it", async () => {
    begin.mockResolvedValue({
      status: "authorization_required",
      authorizationUrl: "https://auth.example.test/authorize",
      sessionId: "ours",
    });
    const server = {
      id: "connection",
      connectionState: "not-connected",
      revision: 4,
      pendingOauthSessionId: "ours" as string | null,
      lastError: null as string | null,
    };
    list.mockImplementation(async () => [server]);
    const result = connectMcpOauth("connection");
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    server.connectionState = "cancelled";
    server.revision = 9;
    server.lastError = "Could not complete sign-in. Connect again.";
    await vi.advanceTimersByTimeAsync(3000);
    expect(settled).toBe(false);
    server.pendingOauthSessionId = null;
    server.connectionState = "connected";
    server.lastError = null;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBe("connected");
  });
  it("keeps waiting when the popup opener is severed and resolves on the callback", async () => {
    const result = waitForMcpOauth(
      "https://auth.example.test/authorize",
      popup as unknown as Window,
      "ours",
    );
    let settled: string | null = null;
    void result.then((value) => {
      settled = value;
    });
    popup.closed = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(settled).toBeNull();
    channel.onmessage?.({ data: { type: "mcp-oauth-complete", sessionId: "ours" } });
    expect(await result).toBe("connected");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels the pending sign-in on the server and resolves cancelled", async () => {
    begin.mockResolvedValue({
      status: "authorization_required",
      authorizationUrl: "https://auth.example.test/authorize",
      sessionId: "ours",
    });
    list.mockResolvedValue([
      { id: "connection", connectionState: "not-connected", pendingOauthSessionId: "ours" },
    ]);
    let controls: { sessionId: string; cancel: () => Promise<void> } | undefined;
    const result = connectMcpOauth("connection", {
      onWaiting: (waiting) => {
        controls = waiting;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(controls?.sessionId).toBe("ours");
    popup.closed = true;
    await vi.advanceTimersByTimeAsync(2_000);
    await controls!.cancel();
    expect(cancel).toHaveBeenCalledWith({ serverId: "connection", sessionId: "ours" });
    expect(await result).toBe("cancelled");
  });
  it("leaves a connected server connected when the popup closes without a callback", async () => {
    begin.mockResolvedValue({
      status: "authorization_required",
      authorizationUrl: "https://auth.example.test/authorize",
      sessionId: "ours",
    });
    const server = {
      id: "connection",
      connectionState: "connected",
      revision: 4,
      pendingOauthSessionId: "ours",
    };
    list.mockImplementation(async () => [server]);
    const result = connectMcpOauth("connection");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(await result).toBe("needs-sign-in");
    expect(server).toMatchObject({ connectionState: "connected", revision: 4 });
  });
  it("reports a post-consent failure instead of a completed sign-in", async () => {
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
    expect(await result).toBe("sign-in-failed");
    expect(popup.close).toHaveBeenCalledOnce();
  });
});
