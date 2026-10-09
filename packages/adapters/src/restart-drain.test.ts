import type { PrismaClient } from "@ardurbot/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drainForShutdown, RestartDrain } from "./restart-drain.js";

afterEach(() => vi.useRealTimers());
function fixture() {
  let state: { restartDrainId?: string | null; restartDrainUntil?: Date | null } = {};
  const deploymentSettings = {
    findUnique: vi.fn(async () => state),
    upsert: vi.fn(async ({ update }: { update: typeof state }) => {
      state = { ...state, ...update };
    }),
    updateMany: vi.fn(async ({ where, data }: { where: typeof state; data: typeof state }) => {
      if (where.restartDrainId !== state.restartDrainId) return { count: 0 };
      state = { ...state, ...data };
      return { count: 1 };
    }),
  };
  const count = vi.fn(async () => 1);
  const queryRaw = vi.fn(async (_query: TemplateStringsArray) => [
    { restartDrainUntil: state.restartDrainUntil ?? null },
  ]);
  const prisma = {
    deploymentSettings,
    run: { count },
    $queryRaw: queryRaw,
  } as unknown as PrismaClient;
  return {
    prisma,
    count,
    queryRaw,
    deploymentSettings,
    state: () => state,
    drain: new RestartDrain(prisma),
  };
}
describe("shared restart admission", () => {
  it("awaits the shared row lock before reading admission state", async () => {
    const f = fixture();
    let release!: () => void;
    const locked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const query = f.queryRaw.mockImplementationOnce(async () => {
      await locked;
      return [];
    });
    const admitting = f.drain.admits(f.prisma as never);
    try {
      const text = String(query.mock.calls[0]?.[0]).replace(/\s+/g, " ").trim();
      expect(text).toBe(
        "SELECT \"restartDrainUntil\" FROM deployment_settings WHERE id = 'default' FOR SHARE",
      );
      expect(f.deploymentSettings.findUnique).not.toHaveBeenCalled();
    } finally {
      release();
    }
    expect(await admitting).toBe(true);
  });
  it("decides admission from the single locked read", async () => {
    const f = fixture();
    expect(await f.drain.admits(f.prisma as never)).toBe(true);
    expect(f.queryRaw).toHaveBeenCalledTimes(1);
    expect(f.deploymentSettings.findUnique).not.toHaveBeenCalled();
    f.queryRaw.mockResolvedValueOnce([{ restartDrainUntil: new Date(Date.now() + 60_000) }]);
    expect(await f.drain.admits(f.prisma as never)).toBe(false);
    expect(f.queryRaw).toHaveBeenCalledTimes(2);
  });
  it("caches the shared drain read between boundary checks, then re-reads", async () => {
    vi.useFakeTimers();
    const f = fixture();
    expect(await f.drain.requested()).toBe(false);
    expect(await f.drain.requested()).toBe(false);
    expect(f.deploymentSettings.findUnique).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await f.drain.requested()).toBe(false);
    expect(f.deploymentSettings.findUnique).toHaveBeenCalledTimes(2);
  });
  it("sees a drain that starts after a cached clear read", async () => {
    const f = fixture();
    f.count.mockResolvedValue(0);
    expect(await f.drain.requested()).toBe(false);
    await f.drain.begin("update", 0);
    expect(await f.drain.requested()).toBe(true);
    expect(f.deploymentSettings.findUnique).toHaveBeenCalledTimes(2);
  });
  it("stops claims on both services and reopens admission after a deadline miss", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const otherService = new RestartDrain(f.prisma);
    const pending = f.drain.begin("update", 60_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(await otherService.requested()).toBe(true);
    expect(f.state().restartDrainUntil!.getTime() - Date.now()).toBe(65 * 60_000);
    expect(await otherService.admits(f.prisma as never)).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await pending).toMatchObject({
      ok: false,
      activeAtStart: 1,
      remaining: 1,
      durationMs: 60_000,
    });
    expect(await otherService.requested()).toBe(false);
    expect(await otherService.admits(f.prisma as never)).toBe(true);
  });
  it("keeps admission closed after success until the updater finishes, with fenced clearing", async () => {
    const f = fixture();
    f.count.mockResolvedValue(0);
    expect(await f.drain.begin("new", 0)).toMatchObject({ ok: true });
    await f.drain.clear("old");
    expect(await f.drain.requested()).toBe(true);
    await f.drain.clear("new");
    expect(await f.drain.requested()).toBe(false);
  });
  it("saves each active turn independently instead of waiting for all bots to be idle", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const first = f.drain.enter()!;
    const second = f.drain.enter()!;
    const stopped = f.drain.shutdown(60_000);
    expect(f.drain.enter()).toBeUndefined();
    first();
    await vi.advanceTimersByTimeAsync(50);
    second();
    await vi.advanceTimersByTimeAsync(50);
    expect(await stopped).toMatchObject({
      ok: true,
      activeAtStart: 2,
      remaining: 0,
      durationMs: 100,
    });
  });
  it("bounds a drain when counting active leases stops answering", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.count.mockImplementation(() => new Promise(() => {}));
    const pending = f.drain.begin("update", 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await pending).toMatchObject({
      ok: false,
      activeAtStart: null,
      remaining: null,
      durationMs: 60_000,
    });
    expect(await f.drain.requested()).toBe(false);
  });
  it("bounds shutdown when a model call is stuck", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const leave = f.drain.enter()!;
    const stopped = f.drain.shutdown(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await stopped).toMatchObject({ ok: false, remaining: 1, durationMs: 60_000 });
    leave();
  });
});

describe.each(["API", "worker"])("%s service shutdown", () => {
  it("keeps the runtime signal alive until saved turns leave, then aborts before closing transports", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const leave = f.drain.enter()!;
    const shutdown = new AbortController();
    const stopped = drainForShutdown(f.drain, shutdown);
    expect(shutdown.signal.aborted).toBe(false);
    expect(f.drain.preparationSignal.aborted).toBe(true);
    expect(f.drain.enter()).toBeUndefined();
    leave();
    await vi.advanceTimersByTimeAsync(50);
    expect(await stopped).toMatchObject({ ok: true, remaining: 0 });
    expect(shutdown.signal.aborted).toBe(true);
    expect(f.drain.deadlineSignal.aborted).toBe(false);
  });
  it("interrupts a stuck turn only after the bounded service deadline", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.drain.enter();
    const shutdown = new AbortController();
    const stopped = drainForShutdown(f.drain, shutdown);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(shutdown.signal.aborted).toBe(false);
    expect(f.drain.deadlineSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await stopped).toMatchObject({ ok: false, remaining: 1 });
    expect(shutdown.signal.aborted).toBe(true);
    expect(f.drain.deadlineSignal.aborted).toBe(true);
  });
});
