import { Prisma, type PrismaClient } from "./client.js";

export class RunnerJobDb {
  constructor(private readonly prisma: PrismaClient) {}

  async createJob(data: Omit<Prisma.RunnerJobUncheckedCreateInput, 'id' | 'queuedAt'>) {
    return this.prisma.runnerJob.create({
      data: {
        ...data,
        state: "staged",
        phase: "pending",
        cleanupState: "pending",
      }
    });
  }

  async getJobByOperationKey(operationKey: string) {
    return this.prisma.runnerJob.findUnique({
      where: { operationKey }
    });
  }

  async updateJobState(id: string, state: string, phase: string, data: Partial<Prisma.RunnerJobUpdateInput> = {}) {
    return this.prisma.runnerJob.update({
      where: { id },
      data: {
        state,
        phase,
        ...data
      }
    });
  }

  async appendEvent(jobId: string, seq: number, executionFence: number, kind: string, payload: string, stream?: string) {
    return this.prisma.runnerJobEvent.create({
      data: {
        jobId,
        seq,
        executionFence,
        kind,
        redactedPayload: payload,
        stream
      }
    });
  }
}
