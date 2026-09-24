import type { MessageBlock } from "@ardurbot/contracts";
import { expect, it, vi } from "vitest";
import type { Prisma } from "./client.js";
import { delegationAnswerThread, delegationApprovalTarget } from "./delegation-approval.js";

it("routes one stable approval identity to the coordinator, naming requester and actor", async () => {
  const tx = {
    run: {
      findUnique: vi.fn(async () => ({ delegationId: "handoff", threadId: "worker-thread" })),
    },
    delegation: {
      findUniqueOrThrow: vi.fn(async () => ({
        rootTaskId: "root",
        requesterName: "Chief",
        actingName: "Reviewer",
      })),
    },
    delegationRoot: {
      findUniqueOrThrow: vi.fn(async () => ({
        coordinatorThreadId: "chief-thread",
        coordinatorBotId: "chief",
      })),
      findFirst: vi.fn(async () => ({ rootTaskId: "root" })),
    },
  } as unknown as Prisma.TransactionClient;
  const blocks: MessageBlock[] = [
    {
      kind: "ask",
      text: "Allow?",
      status: "pending",
      approvalEffectId: "effect",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "always", label: "Always" },
      ],
    },
  ];
  const first = await delegationApprovalTarget(tx, "worker-run", "worker-thread", "worker", blocks);
  expect(
    await delegationApprovalTarget(tx, "worker-run", "worker-thread", "worker", blocks),
  ).toEqual(first);
  expect(first).toMatchObject({
    threadId: "chief-thread",
    clientNonce: "delegation-approval:effect",
    blocks: [
      {
        approvalEffectId: "effect",
        detail: "Requested by Chief — acting as Reviewer",
        actions: [{ id: "allow", label: "Allow once" }],
      },
    ],
  });
  expect(
    await delegationAnswerThread(tx, {
      runId: "worker-run",
      threadId: "chief-thread",
      spaceId: "space",
      answeredByUserId: "owner",
    }),
  ).toBe("worker-thread");
});
