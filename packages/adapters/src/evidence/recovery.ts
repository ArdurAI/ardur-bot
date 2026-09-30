import type { JobPublisher } from "@ardurbot/adapter-kit";
import { evidenceSealJob } from "@ardurbot/adapter-kit";
import type { PrismaClient } from "@ardurbot/db";

/** Recover the commit-to-enqueue window, including journals whose run was deleted. */
export function createEvidenceSealRecovery(deps: { prisma: PrismaClient; jobs: JobPublisher }) {
  let cursor = "";
  return async () => {
    const rows = await deps.prisma.$queryRaw<{ id: string; runId: string }[]>`
      SELECT e.id, e."runId" FROM evidence_records e
      LEFT JOIN evidence_seals s ON s."runId" = e."runId"
      LEFT JOIN runs r ON r.id = e."runId"
      WHERE e.seq = 0 AND s.id IS NULL AND e.id > ${cursor}
        AND (r.id IS NULL OR r.status IN ('completed', 'failed', 'cancelled'))
      ORDER BY e.id LIMIT 100
    `;
    for (const row of rows) await deps.jobs.enqueue(evidenceSealJob(row.runId));
    cursor = rows.length === 100 ? rows.at(-1)!.id : "";
  };
}
