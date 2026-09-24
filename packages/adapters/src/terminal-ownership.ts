import { randomUUID } from "node:crypto";
import { MAX_SANDBOX_COMMAND_TIMEOUT_MS } from "@ardurbot/core";
import type { PrismaClient } from "@ardurbot/db";

export const HUMAN_TERMINAL_CONTROL =
  "A person has control of this computer; wait until they release it.";
export class ComputerAdmissionError extends Error {}
/** Short DB transactions reserve admission; a long command never holds a connection. */
export async function withComputerAdmission<T>(
  prisma: PrismaClient,
  computerId: string,
  work: () => Promise<T>,
  human = false,
): Promise<T> {
  const id = randomUUID();
  await prisma.$transaction(async (tx) => {
    const [lock] = await tx.$queryRaw<
      Array<{ acquired: boolean }>
    >`SELECT pg_try_advisory_xact_lock(hashtext('computer-control'), hashtext(${computerId})) AS acquired`;
    if (!lock?.acquired) throw new ComputerAdmissionError("The computer is busy; try again.");
    const computer = await tx.computer.findUniqueOrThrow({ where: { id: computerId } });
    // Expiry alone cannot resume commands before provider cleanup has cleared control.
    if (!human && computer.controlLeaseId) throw new ComputerAdmissionError(HUMAN_TERMINAL_CONTROL);
    const active = await tx.computerAdmission.findFirst({
      where: { computerId, expiresAt: { gt: new Date() }, ...(human ? {} : { kind: "human" }) },
    });
    if (active) throw new ComputerAdmissionError("The computer is busy; try again.");
    await tx.computerAdmission.deleteMany({
      where: { computerId, expiresAt: { lte: new Date() } },
    });
    await tx.computerAdmission.create({
      data: {
        id,
        computerId,
        kind: human ? "human" : "command",
        expiresAt: new Date(Date.now() + MAX_SANDBOX_COMMAND_TIMEOUT_MS + 60_000),
      },
    });
  });
  try {
    return await work();
  } finally {
    await prisma.computerAdmission.deleteMany({ where: { id } });
  }
}
