import type { Actor } from "@ardurbot/contracts";
import { RoutineRunSchema } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { IsolationError } from "@ardurbot/db";

export async function routineHistory(prisma: PrismaClient, actor: Actor, routineId: string) {
  const where = { spaceId: actor.spaceId, userId: actor.userId };
  if (
    !(await prisma.routine.findFirst({ where: { id: routineId, ...where }, select: { id: true } }))
  )
    throw new IsolationError();
  const attempts = await prisma.run.findMany({
    where: { routineId, ...where },
    select: { id: true, status: true, createdAt: true, completedAt: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 50,
  });
  return attempts.map((attempt) =>
    RoutineRunSchema.parse({
      ...attempt,
      createdAt: attempt.createdAt.toISOString(),
      completedAt: attempt.completedAt?.toISOString() ?? null,
    }),
  );
}
