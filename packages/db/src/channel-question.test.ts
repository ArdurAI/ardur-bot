import { expect, it, vi } from "vitest";
import type { Prisma } from "./client.js";

const answer = vi.hoisted(() => vi.fn(async () => ({ seq: 1, threadId: "thread" })));
vi.mock("./events.js", () => ({ answerWaitingRunWithTextInTransaction: answer }));

import { answerChannelQuestion } from "./messaging-routes.js";

it("resumes ordinary questions but refuses approval, secret, and presence asks", async () => {
  const findMany = vi.fn();
  const tx = { message: { findMany } } as unknown as Prisma.TransactionClient;
  const input = {
    spaceId: "space",
    threadId: "thread",
    runId: "run",
    answeredByUserId: "owner",
    answer: "Untrusted framed answer",
  };
  findMany.mockResolvedValue([
    {
      blocks: [{ kind: "ask", input: "text", text: "Which file?", status: "pending" }],
    },
  ]);
  await answerChannelQuestion(tx, input);
  expect(answer).toHaveBeenCalledOnce();
  for (const fields of [
    { approvalEffectId: "effect" },
    { input: "secret" },
    { actions: [{ id: "remote-retry", label: "Confirm" }] },
  ]) {
    findMany.mockResolvedValue([{ blocks: [{ kind: "ask", status: "pending", ...fields }] }]);
    await expect(answerChannelQuestion(tx, input)).rejects.toThrow(
      "Approve this on your Mac or phone.",
    );
  }
  expect(answer).toHaveBeenCalledOnce();
});
