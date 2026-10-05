import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@ardurbot/db";
import { getLogger } from "@ardurbot/logging";

export const RESTART_DRAIN_MS = 60_000;
// Covers both existing 30-minute recreate/recovery limits, checkout restoration and cleanup.
const RESTART_UPDATE_HOLD_MS = 65 * 60_000;
export interface DrainResult {
  ok: boolean;
  activeAtStart: number | null;
  remaining: number | null;
  durationMs: number;
}

/** Shared admission is durable; process shutdown also closes its own admission immediately. */
export class RestartDrain {
  private stopping = false;
  private readonly active = new Set<symbol>();
  private readonly preparation = new AbortController();
  get preparationSignal(): AbortSignal {
    return this.preparation.signal;
  }
  constructor(private readonly prisma: PrismaClient) {}
  async initialize(): Promise<void> {
    await this.prisma.deploymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default" },
      update: {},
    });
  }
  enter(): (() => void) | undefined {
    if (this.stopping) return undefined;
    const token = Symbol();
    this.active.add(token);
    return () => this.active.delete(token);
  }
  async requested(): Promise<boolean> {
    if (this.stopping) return true;
    const state = await this.prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { restartDrainUntil: true },
    });
    return Boolean(state?.restartDrainUntil && state.restartDrainUntil.getTime() > Date.now());
  }
  /** Called inside the claim transaction. The updater takes the same row's write lock. */
  async admits(tx: Prisma.TransactionClient): Promise<boolean> {
    if (this.stopping) return false;
    await tx.$queryRaw`SELECT id FROM deployment_settings WHERE id = 'default' FOR SHARE`;
    const state = await tx.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { restartDrainUntil: true },
    });
    return !state?.restartDrainUntil || state.restartDrainUntil.getTime() <= Date.now();
  }
  async shutdown(timeoutMs = RESTART_DRAIN_MS): Promise<DrainResult> {
    this.stopping = true;
    this.preparation.abort();
    return this.wait(() => Promise.resolve(this.active.size), timeoutMs);
  }
  async begin(
    id: string = randomUUID(),
    timeoutMs = RESTART_DRAIN_MS,
  ): Promise<DrainResult & { id: string }> {
    // Hold admission through recreate/recovery. A dead updater cannot close admission forever.
    await this.prisma.deploymentSettings.upsert({
      where: { id: "default" },
      create: {
        id: "default",
        restartDrainId: id,
        restartDrainUntil: new Date(Date.now() + RESTART_UPDATE_HOLD_MS),
      },
      update: {
        restartDrainId: id,
        restartDrainUntil: new Date(Date.now() + RESTART_UPDATE_HOLD_MS),
      },
    });
    const result = await this.wait(
      () =>
        this.prisma.run.count({
          where: { status: { in: ["running", "leased"] }, leaseExpiresAt: { gt: new Date() } },
        }),
      timeoutMs,
    );
    if (!result.ok) await this.clear(id);
    return { ...result, id };
  }
  async clear(id: string): Promise<void> {
    await this.prisma.deploymentSettings.updateMany({
      where: { id: "default", restartDrainId: id },
      data: { restartDrainId: null, restartDrainUntil: null },
    });
  }
  private async wait(count: () => Promise<number>, timeoutMs: number): Promise<DrainResult> {
    const started = Date.now();
    let activeAtStart: number | null = null;
    let remaining: number | null = null;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        expired = true;
        resolve();
      }, timeoutMs);
    });
    const poll = async () => {
      activeAtStart = remaining = await count();
      while (!expired && remaining > 0 && Date.now() - started < timeoutMs) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(50, timeoutMs - (Date.now() - started))),
        );
        if (!expired) remaining = await count();
      }
    };
    try {
      await Promise.race([poll(), deadline]);
    } finally {
      clearTimeout(timer);
      expired = true;
    }
    const result = {
      ok: remaining === 0,
      activeAtStart,
      remaining,
      durationMs: Date.now() - started,
    };
    getLogger().info("restart.drain", { ...result, deadlineMiss: !result.ok });
    return result;
  }
}

/** Keep runtime/tool transports alive until the service deadline, then interrupt remaining work. */
export async function drainForShutdown(
  drain: RestartDrain,
  shutdown: AbortController,
): Promise<DrainResult> {
  try {
    return await drain.shutdown();
  } finally {
    shutdown.abort();
  }
}
