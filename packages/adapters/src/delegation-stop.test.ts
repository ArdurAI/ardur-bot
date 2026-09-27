import type { PrismaClient, Run } from "@ardurbot/db";
import { expect, it, vi } from "vitest";
import { stoppedRunComputer } from "./delegation-stop.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { stopRemoteComputerWork } from "./remote-execution.js";

it("keeps a newer run's screen when stopping a waiting run", async () => {
  const sandbox = new FakeSandboxProvider();
  const run = {
    id: "run-a",
    botId: "bot",
    spaceId: "space",
    userId: "owner",
    screenLeaseId: "run-a:1",
  } as Run;
  const computer = await sandbox.provision(
    { botId: run.botId, homePath: "/workspace" },
    {
      operationId: "fixture",
      traceId: "fixture",
      spaceId: run.spaceId,
      userId: run.userId,
      signal: new AbortController().signal,
    },
  );
  const owner = { ...computer, homeKey: run.botId };
  const prisma = {
    computer: { findFirst: vi.fn(async () => ({ ...owner, providerRef: computer.id })) },
  } as unknown as PrismaClient;
  await sandbox.observe(computer, {
    operationId: "run-a",
    traceId: "run-a",
    spaceId: run.spaceId,
    userId: run.userId,
    botId: run.botId,
    screenLeaseId: "run-a:1",
    signal: new AbortController().signal,
  });
  await sandbox.observe(computer, {
    operationId: "run-b",
    traceId: "run-b",
    spaceId: run.spaceId,
    userId: run.userId,
    botId: run.botId,
    screenLeaseId: "run-b:2",
    signal: new AbortController().signal,
  });
  const release = vi.spyOn(sandbox, "releaseScreen");
  const target = await stoppedRunComputer(prisma, run, computer.id);
  expect(target).toBeDefined();
  expect(
    await stopRemoteComputerWork(sandbox, target!.computer, computer.id, run.id, target!.context),
  ).toBe(true);
  expect(release).toHaveBeenCalledWith(
    expect.objectContaining({ id: computer.id }),
    expect.objectContaining({ screenLeaseId: "run-a:1" }),
  );
  expect(sandbox.boxes.get(computer.id)?.screenLeases.get(run.botId)).toBe("run-b:2");
});

it("does not release a screen when the stopped run never held one", async () => {
  const run = { id: "run-a", botId: "bot", spaceId: "space", userId: "owner" } as Run;
  const sandbox = new FakeSandboxProvider();
  const computer = await sandbox.provision(
    { botId: run.botId, homePath: "/workspace" },
    {
      operationId: "fixture",
      traceId: "fixture",
      spaceId: run.spaceId,
      userId: run.userId,
      signal: new AbortController().signal,
    },
  );
  const prisma = {
    computer: {
      findFirst: vi.fn(async () => ({
        id: computer.id,
        homeKey: run.botId,
        kind: computer.kind,
        providerRef: computer.id,
      })),
    },
  } as unknown as PrismaClient;
  const release = vi.spyOn(sandbox, "releaseScreen");
  const target = await stoppedRunComputer(prisma, run, computer.id);
  expect(target).toBeDefined();
  expect(
    await stopRemoteComputerWork(sandbox, target!.computer, computer.id, run.id, target!.context),
  ).toBe(true);
  expect(release).not.toHaveBeenCalled();
});
