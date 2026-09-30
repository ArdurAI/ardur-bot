import type { PrismaClient, ThreadEvents } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import { watchChiefControl } from "./chief-control.js";

function fixture() {
  const prisma = {
    chiefAssignment: {
      findUnique: vi.fn(async () => ({ plan: { threadId: "room" }, supersededAt: null })),
    },
    run: { findUnique: vi.fn(async () => ({ cancelRequestedAt: null })) },
  };
  const abort = vi.fn();
  const events = {
    follow: vi.fn(async function* () {
      yield { type: "chief.control", payload: { stoppedRunIds: ["independent"] } };
      yield { type: "thread.progress", payload: { stoppedRunIds: ["run"] } };
      yield { type: "chief.control", payload: { stoppedRunIds: ["run"] } };
    }),
  };
  return { prisma, events, abort, signal: new AbortController().signal, runId: "run" };
}
describe("chief realtime owned abort", () => {
  it("aborts only the exact owned run from committed control, without generic peer steering", async () => {
    const f = fixture();
    await watchChiefControl({
      ...f,
      prisma: f.prisma as unknown as PrismaClient,
      events: f.events as unknown as ThreadEvents,
    });
    expect(f.abort).toHaveBeenCalledTimes(1);
    expect(f.events.follow).toHaveBeenCalledWith("room", 0, f.signal);
  });
  it("checks durable supersession before subscribing after a restart", async () => {
    const f = fixture();
    f.prisma.chiefAssignment.findUnique.mockResolvedValueOnce({
      plan: { threadId: "room" },
      supersededAt: new Date(),
    } as never);
    await watchChiefControl({
      ...f,
      prisma: f.prisma as unknown as PrismaClient,
      events: f.events as unknown as ThreadEvents,
    });
    expect(f.abort).toHaveBeenCalledTimes(1);
    expect(f.events.follow).not.toHaveBeenCalled();
  });
});
