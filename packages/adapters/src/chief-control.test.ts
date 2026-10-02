import type { PrismaClient, ThreadEvents } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import { chiefVerificationRead, watchChiefControl } from "./chief-control.js";
import {
  grantedMcpTools,
  integrationApprovalForCall,
  mcpGrantForBot,
} from "./integration-access.js";

vi.mock("./integration-access.js", () => ({
  grantedMcpTools: vi.fn(),
  integrationApprovalForCall: vi.fn(),
  mcpGrantForBot: vi.fn(),
}));

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
  it("allows a verification read only on the current chief turn with a fresh captured grant", async () => {
    const f = fixture();
    f.prisma.chiefAssignment.findUnique.mockResolvedValue({
      coordinator: true,
      revision: 2,
      supersededAt: null,
      plan: {
        revision: 2,
        sourceRunId: "run",
        control: {
          revision: 2,
          ownerMessageIds: [],
          excludedIds: [],
          localOnly: false,
          stopped: false,
          pendingReplan: true,
          stoppingRunIds: [],
          uncertainRunIds: ["old"],
          reconciliationRunId: "run",
        },
      },
    } as never);
    Object.assign(f.prisma.run, {
      findUniqueOrThrow: vi.fn(async () => ({ spaceId: "space", userId: "owner", botId: "chief" })),
    });
    const grant = {
      server: {
        revision: 3,
        manifest: {
          capturedAt: new Date().toISOString(),
          serverVersion: "fixture",
          account: null,
          tools: [
            { id: "fetch_page", description: "Read the page", inputSchemaDigest: "a".repeat(64) },
          ],
        },
      },
    };
    vi.mocked(mcpGrantForBot).mockResolvedValue(grant as never);
    vi.mocked(grantedMcpTools).mockReturnValue(["fetch_page"]);
    vi.mocked(integrationApprovalForCall).mockResolvedValue("allow");
    const route = {
      connectorId: "mcp",
      resourceId: "server",
      resourceRevision: 3,
      toolName: "fetch_page",
    };
    expect(await chiefVerificationRead(f.prisma as unknown as PrismaClient, "run", route)).toBe(
      true,
    );
    expect(
      await chiefVerificationRead(f.prisma as unknown as PrismaClient, "run", {
        ...route,
        resourceRevision: 4,
      }),
    ).toBe(false);
    vi.mocked(integrationApprovalForCall).mockResolvedValue("disabled");
    expect(await chiefVerificationRead(f.prisma as unknown as PrismaClient, "run", route)).toBe(
      false,
    );
    vi.mocked(grantedMcpTools).mockReturnValue([]);
    expect(await chiefVerificationRead(f.prisma as unknown as PrismaClient, "run", route)).toBe(
      false,
    );
    f.prisma.chiefAssignment.findUnique.mockResolvedValue({
      coordinator: false,
      plan: {},
    } as never);
    expect(await chiefVerificationRead(f.prisma as unknown as PrismaClient, "run", route)).toBe(
      false,
    );
  });
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
