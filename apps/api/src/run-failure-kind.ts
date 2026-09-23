import { RunFailurePayloadSchema } from "@ardurbot/contracts";
import type { Prisma } from "@ardurbot/db";

/** Recover the classification after a page reload without a run-table migration. */
export async function storedRunFailure(
  tx: Pick<Prisma.TransactionClient, "event">,
  run: { id: string; threadId: string; status: string } | null,
) {
  if (run?.status !== "failed") return undefined;
  const event = await tx.event.findFirst({
    where: { runId: run.id, threadId: run.threadId, type: "run.failed" },
    orderBy: { seq: "desc" },
    select: { payload: true },
  });
  const payload = event?.payload;
  const failure = RunFailurePayloadSchema.safeParse(payload).data;
  return failure
    ? { providerErrorKind: failure.providerErrorKind, runtimeProblem: failure.runtimeProblem }
    : undefined;
}

export async function storedRunFailureKind(...args: Parameters<typeof storedRunFailure>) {
  return (await storedRunFailure(...args))?.providerErrorKind;
}
