import type { BoardRun } from "@ardurbot/contracts/board";
import type { HostFrame, HostRequest } from "@ardurbot/contracts/host-bridge";
import type { PrismaClient } from "@ardurbot/db";
import { afterEach, expect, it, vi } from "vitest";
import { HostBridge } from "./host-bridge.js";

const bridges: HostBridge[] = [];
afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.hub.detach();
});
function fixture() {
  const row = {
    id: "workspace",
    kind: "folder",
    spaceId: "space",
    ownerUserId: "owner",
    path: "/fixture/project",
    prefix: "board",
    enabled: true,
  };
  const prisma = {
    hostRegistration: {
      findUnique: vi.fn(async () => ({
        userId: "owner",
        generation: "generation",
        hostRoots: [row.path],
      })),
    },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({ ownerUserId: "owner", computerHost: "this-mac" })),
    },
    spaceMember: {
      findUnique: vi.fn(async ({ where }) =>
        where.spaceId_userId.spaceId === "space" ? {} : null,
      ),
    },
    user: { findUnique: vi.fn(async () => ({ name: "Board owner" })) },
    run: {
      findFirst: vi.fn(async () => ({
        id: "run",
        status: "running",
        bot: { spaceId: "space", name: "Builder", computer: { kind: "desktop" } },
      })),
    },
    boardWorkspace: {
      findFirst: vi.fn(async ({ where }) =>
        where.id === row.id && where.spaceId === row.spaceId ? row : null,
      ),
    },
  };
  const bridge = new HostBridge(prisma as unknown as PrismaClient, "fixture-encryption-material");
  bridges.push(bridge);
  const host = { send: vi.fn(async (_frame: HostFrame) => undefined), close: vi.fn() };
  const worker = { send: vi.fn(async (_frame: HostFrame) => undefined), close: vi.fn() };
  bridge.hub.attach(host, "owner", "generation");
  const command: BoardRun = {
    action: "command",
    workspaceId: "workspace",
    workspace: { kind: "folder", path: row.path },
    actor: "bot:Builder",
    argv: ["ready", "--limit", "0"],
  };
  const request: HostRequest = {
    v: 1,
    type: "request",
    id: "request",
    scope: { userId: "owner", spaceId: "space", botId: "builder", runId: "run" },
    operation: { op: "board.run", request: command },
  };
  return { prisma, bridge, host, worker, request, command };
}
it("checks board workspace, space, identity and registered root on the bridge", async () => {
  const { prisma, bridge, host, worker, request, command } = fixture();
  await bridge.hub.request(request, worker);
  expect(host.send).toHaveBeenCalledWith(request);
  await bridge.hub.fromHost(host, { v: 1, type: "end", id: request.id });
  host.send.mockClear();
  const invalid = [
    { ...request, scope: { ...request.scope, spaceId: "foreign" } },
    { ...request, scope: { ...request.scope, userId: "member" } },
    ...[
      { ...command, workspaceId: "foreign" },
      { ...command, actor: "forged" },
      { ...command, workspace: { kind: "folder" as const, path: "/outside" } },
      { ...command, action: "init" as const, prefix: "board" },
    ].map((value) => ({ ...request, operation: { op: "board.run" as const, request: value } })),
  ];
  for (const [index, refused] of invalid.entries())
    await bridge.hub.request({ ...refused, id: `refused-${index}` }, worker);
  expect(host.send).not.toHaveBeenCalled();
  prisma.hostRegistration.findUnique.mockResolvedValueOnce({
    userId: "owner",
    generation: "revoked",
    hostRoots: ["/fixture/project"],
  });
  await bridge.hub.request({ ...request, id: "revoked" }, worker);
  expect(host.send).not.toHaveBeenCalled();
});
it("refuses a bot's board command unless its computer is a host computer", async () => {
  const { prisma, bridge, host, worker, request } = fixture();
  for (const computer of [{ kind: "docker", connectionId: null }, { kind: "e2b" }, null])
    prisma.run.findFirst.mockResolvedValueOnce({
      id: "run",
      status: "running",
      bot: { spaceId: "space", name: "Builder", computer },
    } as never);
  for (const index of [0, 1, 2])
    await bridge.hub.request({ ...request, id: `docker-${index}` }, worker);
  expect(host.send).not.toHaveBeenCalled();
  await bridge.hub.request(request, worker);
  expect(host.send).toHaveBeenCalledWith(request);
});
it("round-trips an authenticated owner's streamed result without granting a worker a manual identity", async () => {
  const { bridge, host, command } = fixture();
  host.send.mockImplementation(async (frame) => {
    if (frame.type !== "request") return;
    await bridge.hub.fromHost(host, {
      v: 1,
      type: "stream",
      id: frame.id,
      seq: 0,
      channel: "stdout",
      data: "[]",
    });
    await bridge.hub.fromHost(host, {
      v: 1,
      type: "stream",
      id: frame.id,
      seq: 1,
      channel: "result",
      data: { ok: true },
    });
    await bridge.hub.fromHost(host, { v: 1, type: "end", id: frame.id });
  });
  expect(
    await bridge.runBoard(
      { ...command, actor: "Board owner" },
      { userId: "owner", spaceId: "space" },
    ),
  ).toEqual({ ok: true, stdout: "[]" });
  await expect(
    bridge.runBoard({ ...command, actor: "forged" }, { userId: "owner", spaceId: "space" }),
  ).rejects.toThrow();
});
it("permits only the saved item's outcome after completion", async () => {
  const { prisma, bridge, host, worker, request, command } = fixture();
  prisma.run.findFirst.mockImplementation(async ({ where }) =>
    typeof where.status === "string"
      ? null
      : ({
          id: "run",
          status: "completed",
          boardItemId: "board-a",
          boardWorkspaceId: "workspace",
          boardCloseWhenDone: false,
          bot: { spaceId: "space", name: "Builder", computer: { kind: "desktop" } },
        } as never),
  );
  const send = async (id: string, argv: string[]) => {
    await bridge.hub.request(
      { ...request, id, operation: { op: "board.run", request: { ...command, argv } } },
      worker,
    );
    await bridge.hub.fromHost(host, { v: 1, type: "end", id });
  };
  await send("outcome", ["comments", "add", "--", "board-a", "[Run run] Completed\nChecked"]);
  expect(host.send).toHaveBeenCalledTimes(1);
  host.send.mockClear();
  await send("other", ["comments", "add", "--", "board-b", "[Run run] Completed\nChecked"]);
  await send("create", ["create", "--title", "Unexpected"]);
  await send("close", ["close", "board-a", "--reason", "Bot reported done"]);
  expect(host.send).not.toHaveBeenCalled();
});
