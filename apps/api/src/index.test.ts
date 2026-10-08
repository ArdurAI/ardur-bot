import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const boot = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  install: vi.fn(),
  serve: vi.fn(),
  logger: { info: vi.fn(), error: vi.fn(), flush: vi.fn() },
}));
vi.mock("@ardurbot/core/node/load-root-env", () => ({ loadRootEnv: vi.fn() }));
vi.mock("@ardurbot/logging/axiom", () => ({ createRootLogger: () => boot.logger }));
vi.mock("@hono/node-server", () => ({ serve: boot.serve }));
vi.mock("./app-env.js", () => ({ loadAppEnv: () => ({ apiHost: "127.0.0.1", port: 3100 }) }));
vi.mock("./app.js", () => ({
  createApp: async () => ({
    app: { fetch: vi.fn() },
    stop: boot.stop,
    installTerminal: boot.install,
    startDeviceListener: boot.start,
  }),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  boot.start.mockResolvedValue(undefined);
  boot.stop.mockResolvedValue(undefined);
  boot.logger.flush.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());
function fixture(failApi = false) {
  const server = Object.assign(new EventEmitter(), {
    closeAllConnections: vi.fn(),
    close: vi.fn((closed: () => void) => closed()),
  });
  const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  boot.serve.mockImplementation(() => {
    queueMicrotask(() => {
      server.emit("connection", socket);
      server.emit(failApi ? "error" : "listening", new Error("Fixture API bind failure"));
    });
    return server;
  });
  const signals = new Map<string, () => void>();
  vi.spyOn(process, "once").mockImplementation(((name: string, callback: () => void) => {
    signals.set(name, callback);
    return process;
  }) as typeof process.once);
  const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  return { server, signals, exit, socket };
}
it("starts the device listener after the local API is ready and closes it on shutdown", async () => {
  const f = fixture();
  await import("./index.js");
  expect(boot.start).toHaveBeenCalledOnce();
  expect(boot.install).toHaveBeenCalledWith(f.server);
  f.signals.get("SIGTERM")!();
  f.signals.get("SIGINT")!();
  await vi.waitFor(() => expect(boot.stop).toHaveBeenCalledOnce());
  expect(f.server.close).toHaveBeenCalledOnce();
  expect(f.exit).not.toHaveBeenCalled();
});
it("closes the API and application resources and visibly fails startup when the device bind fails", async () => {
  const f = fixture();
  boot.start.mockRejectedValue(new Error("Fixture device bind failure"));
  await import("./index.js");
  expect(f.socket.destroy).toHaveBeenCalledOnce();
  expect(f.server.closeAllConnections).toHaveBeenCalledOnce();
  expect(f.server.close).toHaveBeenCalledOnce();
  expect(boot.stop).toHaveBeenCalledOnce();
  expect(boot.install).not.toHaveBeenCalled();
  expect(boot.logger.error).toHaveBeenCalledWith("api startup failed", expect.any(Error));
  expect(f.exit).toHaveBeenCalledWith(1);
});
it("cleans up a failed API bind without starting the device listener", async () => {
  const f = fixture(true);
  await import("./index.js");
  expect(boot.start).not.toHaveBeenCalled();
  expect(boot.stop).toHaveBeenCalledOnce();
  expect(f.exit).toHaveBeenCalledWith(1);
});
