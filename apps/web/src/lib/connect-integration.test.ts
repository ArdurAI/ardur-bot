import type { IntegrationConnection, IntegrationDescriptor } from "@ardurbot/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectIntegration } from "./connect-integration";

const api = vi.hoisted(() => ({ connect: vi.fn(), status: vi.fn(), desktop: vi.fn() }));
vi.mock("./rpc", () => ({ rpc: { integrations: api } }));
vi.mock("./desktop", () => ({ desktopBridge: api.desktop }));
const descriptor = { id: "notion", authKind: "oauth" } as IntegrationDescriptor;
const awaiting = { id: "connection", state: "awaiting-consent" } as IntegrationConnection;
const connected = { ...awaiting, state: "connected" } as IntegrationConnection;
let popup: { location: { href: string }; close: ReturnType<typeof vi.fn>; closed: boolean };
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  popup = { location: { href: "" }, close: vi.fn(), closed: false };
  vi.stubGlobal("window", { open: vi.fn(() => popup), setTimeout, location: { assign: vi.fn() } });
  api.connect.mockResolvedValue({
    connection: awaiting,
    authorizationUrl: "https://auth.example.test/authorize",
    sessionId: "test-session",
  });
  api.status.mockResolvedValue(connected);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("integration completion delivery", () => {
  it("opens desktop consent externally, polls its server row, focuses the window and returns the updated card", async () => {
    const desktop = { open: vi.fn(), focus: vi.fn() };
    api.desktop.mockReturnValue({ integrations: desktop });
    const onStarted = vi.fn();
    const result = connectIntegration(descriptor, undefined, { onStarted });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toEqual(connected);
    expect(desktop.open).toHaveBeenCalledWith("https://auth.example.test/authorize");
    expect(desktop.focus).toHaveBeenCalledOnce();
    expect(window.open).not.toHaveBeenCalled();
    expect(onStarted).toHaveBeenCalledWith(awaiting);
    expect(api.status).toHaveBeenCalledWith({ connectionId: "connection" });
  });
  it("survives a severed popup opener and a transient poll failure", async () => {
    api.status.mockRejectedValueOnce(new TypeError("offline"));
    popup.closed = true;
    const result = connectIntegration(descriptor);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toEqual(connected);
    expect(popup.location.href).toBe("https://auth.example.test/authorize");
    expect(popup.close).toHaveBeenCalledOnce();
    expect(api.status).toHaveBeenCalledTimes(2);
  });
  it("returns cancellation or timeout from the server without treating a closed popup as consent", async () => {
    api.status.mockResolvedValue({
      ...awaiting,
      state: "not-connected",
      lastError: "Sign-in timed out.",
    });
    const result = connectIntegration(descriptor);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await result).lastError).toBe("Sign-in timed out.");
  });
  it("passes host intent without opening a browser or sending a token", async () => {
    api.connect.mockResolvedValue({
      connection: connected,
      authorizationUrl: null,
      sessionId: null,
    });
    expect(
      await connectIntegration({ ...descriptor, id: "github" }, undefined, {
        authKind: "host",
        token: "fake-unused",
      }),
    ).toEqual(connected);
    expect(api.connect).toHaveBeenCalledWith(
      expect.objectContaining({ authKind: "host", token: undefined }),
    );
    expect(window.open).not.toHaveBeenCalled();
  });
});
