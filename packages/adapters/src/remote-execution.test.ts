import type { SandboxProvider } from "@ardurbot/adapter-kit";
import { ALL_DEVICE_SCOPES, canonicalDispatchJson } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { deviceDigest } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import { boundDirectApprovalRequest } from "./approval-effect.js";
import {
  currentRemoteDecision,
  deviceThreadProjection,
  enforceRemoteExecution,
  REMOTE_APPROVAL_MARKER,
  revalidateDeviceApprovalExecution,
  stopRemoteComputerWork,
  validateDeviceApproval,
} from "./remote-execution.js";

function fixture() {
  const run = {
    id: "run",
    botId: "bot",
    taskId: "task",
    spaceId: "space",
    userId: "owner",
    originDeviceGrantId: "phone",
    remoteDeviceGrantIds: ["phone"],
    status: "waiting_input",
  };
  const grant = {
    id: "phone",
    instanceId: "home",
    spaceId: "space",
    userId: "owner",
    scopes: [...ALL_DEVICE_SCOPES],
    revokedAt: null as Date | null,
    lastPresenceAt: new Date(),
  };
  const request = boundDirectApprovalRequest(
    { connectorId: "mcp", resourceId: "connector", resourceRevision: 2, toolName: "deploy" },
    { target: "test" },
    REMOTE_APPROVAL_MARKER,
  );
  const effect = { id: "effect", kind: "deploy", runId: "run", request };
  const binding = {
    effectId: "effect",
    instanceId: "home",
    spaceId: "space",
    userId: "owner",
    taskId: "task",
    runId: "run",
    botId: "bot",
    nonce: "single-use",
    requestFingerprint: deviceDigest(canonicalDispatchJson(request)),
    expiresAt: new Date(Date.now() + 60_000),
    answeredAt: null as Date | null,
    executedAt: null as Date | null,
    answeredByGrantId: null as string | null,
  };
  const assignment = {
    server: { revision: 2, catalogId: null, enabled: true },
    allowedTools: ["deploy"],
    allowAllTools: false,
  };
  const tx = {
    run: { findUnique: vi.fn(async () => run), update: vi.fn(async () => run) },
    deviceGrant: {
      findUnique: vi.fn(async (_input: { where: { id: string } }) => grant),
      findFirst: vi.fn(async () => (grant.revokedAt ? null : grant)),
    },
    instanceIdentity: {
      findUnique: vi.fn(async () => ({ instanceId: "home", scopes: ALL_DEVICE_SCOPES })),
    },
    spaceMember: { findUnique: vi.fn(async () => ({ id: "member" })) },
    bot: { findFirst: vi.fn(async () => ({ id: "bot" })) },
    botMcpServer: { findFirst: vi.fn(async () => assignment) },
    remoteAuthorityPolicy: { findMany: vi.fn(async () => []) },
    deviceAuditEvent: { create: vi.fn(async () => ({})) },
    deviceApprovalBinding: {
      findUnique: vi.fn(async () => binding),
      updateMany: vi.fn(async ({ data }) => {
        Object.assign(binding, data);
        return { count: 1 };
      }),
    },
    externalEffect: { findUniqueOrThrow: vi.fn(async () => effect) },
  };
  return {
    db: tx as unknown as PrismaClient,
    tx,
    run,
    grant,
    binding,
    effect,
    assignment,
    answer: {
      effectId: "effect",
      nonce: "single-use",
      requestFingerprint: binding.requestFingerprint,
      grantId: "phone",
      instanceId: "home",
    },
  };
}
describe("executor device boundary", () => {
  it("pauses a deploy the bot may run, then permits it with presence, and blocks after revocation", async () => {
    const f = fixture();
    f.grant.lastPresenceAt = new Date(0);
    const pause = vi.fn(async () => undefined);
    expect(
      await enforceRemoteExecution({ prisma: f.db, runId: "run", tool: "deploy", pause }),
    ).toBe(false);
    expect(pause).toHaveBeenCalledWith(expect.any(String), "Confirm on your phone");
    f.grant.lastPresenceAt = new Date();
    expect((await currentRemoteDecision(f.db, "run", "deploy")).allowed).toBe(true);
    f.grant.revokedAt = new Date();
    expect((await currentRemoteDecision(f.db, "run", "deploy")).allowed).toBe(false);
  });
  it("rechecks every contributing device after steering and delegation", async () => {
    const f = fixture();
    f.run.remoteDeviceGrantIds.push("phone-b");
    f.tx.deviceGrant.findUnique.mockImplementation(async ({ where }) =>
      where.id === "phone-b" ? { ...f.grant, scopes: ["read" as const] } : f.grant,
    );
    expect((await currentRemoteDecision(f.db, "run", "shell")).allowed).toBe(false);
  });
  it("rejects an unbound legacy approval", async () => {
    const f = fixture();
    await expect(
      validateDeviceApproval(f.db, { ...f.effect, request: { target: "test" } }, f.answer),
    ).rejects.toThrow("older approval");
  });
  it("rejects changed arguments, revisions, expiry and a reused approval nonce", async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => {
        f.answer.requestFingerprint = "changed";
      },
      (f: ReturnType<typeof fixture>) => {
        f.assignment.server.revision = 3;
      },
      (f: ReturnType<typeof fixture>) => {
        f.binding.expiresAt = new Date(0);
      },
      (f: ReturnType<typeof fixture>) => {
        f.binding.answeredAt = new Date();
      },
    ]) {
      const f = fixture();
      mutate(f);
      await expect(validateDeviceApproval(f.db, f.effect, f.answer)).rejects.toThrow();
      expect(f.tx.deviceApprovalBinding.updateMany).not.toHaveBeenCalled();
    }
  });
  it("accepts an exact bound approval and revalidates revocation before execution", async () => {
    const f = fixture();
    await validateDeviceApproval(f.db, f.effect, f.answer);
    expect(f.binding.answeredByGrantId).toBe("phone");
    f.grant.revokedAt = new Date();
    await expect(
      revalidateDeviceApprovalExecution(f.db, "effect", "run", "deploy"),
    ).rejects.toThrow("no longer");
    expect(f.binding.executedAt).toBeNull();
  });
});

it("requires positive cleanup evidence before confirming a stop", async () => {
  const releaseScreen = vi.fn(async () => undefined);
  let failed = false;
  const sandbox = {
    releaseScreen,
    async *execute(_computer: unknown, input: { argv: string[] }) {
      if (failed) throw new Error("unreachable");
      if (input.argv[3] === "ardurbot-background-probe") {
        yield { type: "stdout", data: "ardurbot-background-idle\n" };
        yield { type: "exit", code: 1 };
      } else yield { type: "exit", code: 0 };
    },
  } as unknown as SandboxProvider;
  const context = {
    operationId: "stop",
    traceId: "stop",
    spaceId: "space",
    userId: "owner",
    signal: new AbortController().signal,
  };
  expect(
    await stopRemoteComputerWork(
      sandbox,
      { id: "computer", kind: "docker" } as never,
      "computer",
      "run",
      context,
    ),
  ).toBe(true);
  expect(releaseScreen).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ cancelRunWork: true }),
  );
  failed = true;
  expect(await stopRemoteComputerWork(sandbox, {} as never, "computer", "run", context)).toBe(
    false,
  );
});
it("allows denial without recent presence and removes permission-expanding controls", async () => {
  const f = fixture();
  f.grant.lastPresenceAt = new Date(0);
  await validateDeviceApproval(f.db, f.effect, { ...f.answer, decision: "deny" });
  expect(f.binding.answeredAt).not.toBeNull();
  expect(
    deviceThreadProjection({
      blocks: [{ kind: "ask", actions: [{ id: "allow" }, { id: "always" }] }],
    }),
  ).toEqual({ blocks: [{ kind: "ask", actions: [{ id: "allow" }] }] });
});

it("narrows an existing child when another device later steers its parent", async () => {
  const f = fixture();
  const run = {
    ...f.run,
    taskId: "child-task",
    remoteRootTaskId: "parent-task",
    originDeviceGrantId: null,
    remoteDeviceGrantIds: [],
  };
  const db = {
    ...f.db,
    run: {
      ...f.tx.run,
      findUnique: async () => run,
      findMany: async () => [{ ...f.run, remoteDeviceGrantIds: ["phone"] }],
    },
  } as unknown as PrismaClient;
  f.grant.revokedAt = new Date();
  expect((await currentRemoteDecision(db, "run", "shell")).allowed).toBe(false);
  expect(deviceThreadProjection({ spaces: [{ id: "space" }, { id: "other" }] }, "space")).toEqual({
    spaces: [{ id: "space" }],
  });
});
