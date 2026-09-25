import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configureMcp: vi.fn(async (_rows: unknown[]) => {}),
  read: vi.fn(),
  sockets: [] as EventEmitter[],
}));
vi.mock("./mcp-configuration.js", () => ({ readHostMcpConfiguration: mocks.read }));
vi.mock("@ardurbot/host-runtime/desktop-sandbox-win32-path", () => ({
  installWin32NativeApi: vi.fn(),
}));
vi.mock("@ardurbot/host-runtime/bridge-wire", () => ({
  receiveFrames: vi.fn(),
  wsWire: () => ({ send: vi.fn(async () => {}) }),
}));
vi.mock("@ardurbot/host-runtime/host-agent", () => ({
  HostAgent: class {
    initialize = vi.fn(async () => {});
    configureMcp = mocks.configureMcp;
    health = vi.fn(async () => ({}));
    close = vi.fn();
  },
}));
vi.mock("ws", () => ({
  default: class extends EventEmitter {
    constructor() {
      super();
      mocks.sockets.push(this);
    }
  },
}));

const events = [
  "message",
  "disconnect",
  "SIGTERM",
  "SIGINT",
  "uncaughtException",
  "unhandledRejection",
] as const;
const processEvents: EventEmitter = process;
const original = new Map(events.map((event) => [event, processEvents.listeners(event)]));
afterEach(() => {
  for (const event of events)
    for (const listener of processEvents.listeners(event))
      if (!original.get(event)!.includes(listener))
        processEvents.removeListener(event, listener as (...args: unknown[]) => void);
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("preserves successful MCP registrations through poll failures and applies authenticated empty responses", async () => {
  vi.useFakeTimers();
  const registrations = [{ serverId: "server", revision: 1 }];
  mocks.read
    .mockResolvedValueOnce(registrations)
    .mockRejectedValue(new Error("Temporarily unavailable"));
  await import("./index.js");
  process.emit(
    "message",
    {
      apiUrl: "https://example.test",
      token: "x".repeat(43),
      root: "/fixture",
      hostRoots: ["/fixture"],
    },
    undefined,
  );
  await vi.waitFor(() => expect(mocks.sockets).toHaveLength(1));
  mocks.sockets[0]!.emit("open");
  expect(mocks.configureMcp).toHaveBeenCalledExactlyOnceWith(registrations);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(mocks.read).toHaveBeenCalledTimes(3);
  expect(mocks.configureMcp).toHaveBeenCalledTimes(1);
  mocks.read.mockResolvedValueOnce([]);
  await vi.advanceTimersByTimeAsync(5000);
  expect(mocks.configureMcp).toHaveBeenLastCalledWith([]);
  expect(mocks.configureMcp).toHaveBeenCalledTimes(2);
});
