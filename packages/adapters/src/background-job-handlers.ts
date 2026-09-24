import type {
  AgentHomeStore,
  AgentRuntime,
  BackgroundJobHandlers,
  JobPublisher,
  MessagingSurface,
  SandboxProvider,
} from "@ardurbot/adapter-kit";
import { messagingDeliverJob } from "@ardurbot/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@ardurbot/db";
import { getLogger } from "@ardurbot/logging";
import type { MemoryService } from "@ardurbot/memory";
import { deliverMemory } from "@ardurbot/memory";
import type { CloudAgentConnection } from "./cloud-agent-factory.js";
import { pollCloudAgent } from "./cloud-agent-poll.js";
import { expireComputerControl } from "./computer-control.js";
import { scheduleComputerSleep, sleepComputerIfIdle } from "./computer-idle.js";
import { performComputerUpdate } from "./computer-update.js";
import type { createRunExecutor } from "./executor.js";
import { compactHistory } from "./history-compaction.js";
import { curateLearningSpaces } from "./learning-curator.js";
import { enqueueLearningReview } from "./learning-queue.js";
import { reviewLearning } from "./learning-review.js";
import type { LocalImportJobOptions } from "./local-import-jobs.js";
import { createLocalImportJobs } from "./local-import-jobs.js";
import type { MemoryProviderResolver } from "./memory-provider-factory.js";
import { deliverMessagingOutbound, mirrorMessagingOutbound } from "./messaging-delivery.js";
import type { EncryptedSecretStore } from "./secrets.js";
import { expireTaughtSkillTeaching } from "./teaching-session.js";

export function createBackgroundJobHandlers(deps: {
  executor: ReturnType<typeof createRunExecutor>;
  prisma: PrismaClient;
  sandbox: SandboxProvider;
  home: AgentHomeStore;
  jobs: JobPublisher;
  events: ThreadEvents;
  workerId: string;
  runtime: AgentRuntime;
  secretStore: EncryptedSecretStore;
  memoryProviders: MemoryProviderResolver;
  memoryDocuments?: MemoryService;
  localImport?: LocalImportJobOptions;
  deploymentModelKey?: string;
  messaging?: MessagingSurface;
  cloudAgent?: CloudAgentConnection | null;
}): BackgroundJobHandlers {
  const deliverMessaging = async (runId?: string) => {
    if (!deps.messaging) return;
    await deliverMessagingOutbound(
      { prisma: deps.prisma, messaging: deps.messaging, events: deps.events, jobs: deps.jobs },
      { runId },
      {
        operationId: `messaging.deliver:${runId ?? "drain"}`,
        traceId: `messaging.deliver:${runId ?? "drain"}`,
        spaceId: "",
        userId: "",
        signal: new AbortController().signal,
      },
    );
  };

  return {
    ...(deps.localImport && deps.memoryDocuments
      ? createLocalImportJobs(deps.prisma, deps.memoryDocuments, deps.localImport)
      : {}),
    "learning.curate": (payload) => curateLearningSpaces(deps, payload),
    "learning.review": (payload) =>
      reviewLearning(
        {
          prisma: deps.prisma,
          runtime: deps.runtime,
          secretStore: deps.secretStore,
          memoryDocuments: deps.memoryDocuments,
        },
        payload,
      ),
    "memory.git-push": async (payload) => {
      if (!deps.memoryDocuments) throw new Error("Memory sync is unavailable.");
      const context = {
        ...payload,
        memoryGeneration: payload.generation,
        operationId: "memory.git-push",
        traceId: "memory.git-push",
        signal: AbortSignal.timeout(30_000),
      };
      if (
        payload.generation !== undefined &&
        (await deps.memoryDocuments.generation({ ...context, memoryGeneration: undefined })) !==
          payload.generation
      )
        return;
      await deps.memoryDocuments.push(context);
    },
    "memory.deliver": async (payload) => {
      if (!deps.memoryDocuments) throw new Error("Memory delivery is unavailable.");
      await deliverMemory(deps.memoryDocuments, payload.documentId, payload.revision, {
        spaceId: payload.spaceId,
        userId: payload.userId,
        memoryGeneration: payload.generation,
        operationId: "memory.deliver",
        traceId: "memory.deliver",
        signal: AbortSignal.timeout(30_000),
      });
    },
    "run.continue": async (payload) => {
      await deps.executor.continueRun(payload.runId, deps.workerId);
      await enqueueLearningReview(deps, payload.runId);
      // Automatic messaging mirror: once the run's bot messages are durable,
      // copy them into the outbox. Never let mirror failures fail the run.
      if (deps.messaging) {
        await mirrorMessagingOutbound(
          { prisma: deps.prisma, messaging: deps.messaging, events: deps.events, jobs: deps.jobs },
          payload.runId,
        );
        await deps.jobs.enqueue(messagingDeliverJob()).catch(async (error) => {
          getLogger().error("messaging.deliver enqueue error", error);
          await deliverMessaging();
        });
      }
    },
    "messaging.deliver": async (payload) => {
      await deliverMessaging(payload.runId);
    },
    "routine.wakeup": async (payload) => {
      await deps.executor.wakeRoutine(payload.routineId, payload.scheduledFor);
    },
    "computer.update": async ({ updateId }) => {
      await performComputerUpdate(deps, updateId);
    },
    "computer.sleep": async (payload) => {
      await sleepComputerIfIdle(deps, payload.computerId);
    },
    "computer.control-expire": async (payload) => {
      if (await expireComputerControl(deps, payload.computerId, payload.leaseId)) {
        scheduleComputerSleep(deps.jobs, payload.computerId);
      }
    },
    "skill.teaching-expire": async (payload) => {
      await expireTaughtSkillTeaching(deps, payload.skillId);
    },
    "cloud_agent.poll": async (payload) => {
      await pollCloudAgent(
        {
          prisma: deps.prisma,
          jobs: deps.jobs,
          events: deps.events,
          cloudAgent: deps.cloudAgent,
        },
        payload,
      );
    },
    "history.compact": async (payload) => {
      await compactHistory(
        {
          prisma: deps.prisma,
          runtime: deps.runtime,
          jobs: deps.jobs,
          memoryProviders: deps.memoryProviders,
          deploymentModelKey: deps.deploymentModelKey,
          ...(deps.executor.resolveModel ? { resolveModel: deps.executor.resolveModel } : {}),
        },
        payload.threadId,
      );
    },
  };
}
