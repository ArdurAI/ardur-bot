import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configureMcp: vi.fn(async (_rows: unknown[]) => {}),
  read: vi.fn(),
  close: vi.fn(),
  sockets: [] as EventEmitter[],
  process: { on: vi.fn(), once: vi.fn(), send: vi.fn(), exit: vi.fn() },
}));
vi.mock("node:process", () => ({ default: mocks.process }));
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
    close = mocks.close;
  },
}));
vi.mock("ws", () => ({
  default: class extends EventEmitter {
    close = vi.fn();
    terminate = vi.fn();
    constructor() {
      super();
      mocks.sockets.push(this);
    }
  },
}));

// The service owns its child-process IPC. Vitest's worker IPC must not configure
// or stop it, and service state messages must not be sent to the test runner.
const processEvents = new EventEmitter();
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.process.on.mockImplementation((event, listener) => processEvents.on(event, listener));
  mocks.process.once.mockImplementation((event, listener) => processEvents.once(event, listener));
  vi.useFakeTimers();
  vi.setSystemTime(0);
  mocks.sockets.length = 0;
  vi.stubGlobal("fetch", mocks.read);
});
afterEach(() => {
  processEvents.removeAllListeners();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const registrations = [
  {
    serverId: "server",
    userId: "owner",
    spaceId: "space",
    revision: 1,
    command: "node",
    args: [],
    env: {},
    cwd: ".",
    redactions: [],
  },
];
async function connect() {
  mocks.read.mockResolvedValueOnce(Response.json(registrations));
  await import("./index.js");
  processEvents.emit(
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
}

it("preserves successful MCP registrations through poll failures and applies authenticated empty responses", async () => {
  mocks.read.mockRejectedValue(new Error("Temporarily unavailable"));
  await connect();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(mocks.read).toHaveBeenCalledTimes(3);
  expect(mocks.configureMcp).toHaveBeenCalledTimes(1);
  mocks.read.mockResolvedValueOnce(Response.json([]));
  await vi.advanceTimersByTimeAsync(5000);
  expect(mocks.configureMcp).toHaveBeenLastCalledWith([]);
  expect(mocks.configureMcp).toHaveBeenCalledTimes(2);
});

it.each([401, 403, 404, 410])(
  "clears MCP registrations and stops reconnecting after HTTP %i",
  async (status) => {
    await connect();
    mocks.read.mockImplementation(async () => new Response(null, { status }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.configureMcp).toHaveBeenLastCalledWith([]);
    expect(mocks.close).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(mocks.sockets).toHaveLength(1);
  },
);

it.each(["network", "server"])(
  "expires stale MCP registrations after a bounded %s outage and recovers on success",
  async (failure) => {
    await connect();
    mocks.read.mockImplementation(async () => {
      if (failure === "network") throw new Error("Offline");
      return new Response(null, { status: 503 });
    });
    await vi.advanceTimersByTimeAsync(55_000);
    expect(mocks.configureMcp).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.configureMcp).toHaveBeenLastCalledWith([]);
    mocks.read.mockResolvedValueOnce(Response.json(registrations));
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.configureMcp).toHaveBeenLastCalledWith(registrations);
    await vi.advanceTimersByTimeAsync(55_000);
    expect(mocks.configureMcp).toHaveBeenLastCalledWith(registrations);
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.configureMcp).toHaveBeenLastCalledWith([]);
  },
);

it("does not retry a permanent configuration failure during initial connection", async () => {
  mocks.read.mockImplementation(async () => new Response(null, { status: 401 }));
  await import("./index.js");
  processEvents.emit(
    "message",
    {
      apiUrl: "https://example.test",
      token: "x".repeat(43),
      root: "/fixture",
      hostRoots: ["/fixture"],
    },
    undefined,
  );
  await vi.advanceTimersByTimeAsync(60_000);
  expect(mocks.read).toHaveBeenCalledTimes(1);
  expect(mocks.configureMcp).toHaveBeenCalledWith([]);
  expect(mocks.close).toHaveBeenCalled();
  expect(mocks.sockets).toHaveLength(0);
  expect(mocks.process.send).toHaveBeenCalledWith({ type: "host-state", connected: false });
  expect(mocks.process.exit).not.toHaveBeenCalled();
});

it("closes the agent and exits only after the shutdown grace period", async () => {
  await connect();
  processEvents.emit("message", { type: "stop" });
  expect(mocks.close).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1499);
  expect(mocks.process.exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.process.exit).toHaveBeenCalledExactlyOnceWith(0);
});
