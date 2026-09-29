import type {
  AgentHomeStore,
  AgentRuntime,
  JobPublisher,
  SandboxProvider,
} from "@ardurbot/adapter-kit";
import type { RuntimeAvailability, RuntimeKind, RuntimePin } from "@ardurbot/contracts";
import type { PrismaClient, ThreadEvents } from "@ardurbot/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBackgroundJobHandlers } from "./background-job-handlers.js";
import { createRunExecutor } from "./executor.js";
import type * as LearningReviewModule from "./learning-review.js";
import { reviewLearning } from "./learning-review.js";
import type * as RuntimeRegistryModule from "./runtime-registry.js";
import { createRuntimeRegistry, RuntimeRegistry } from "./runtime-registry.js";
import { NATIVE_HOST_OWNER_MESSAGE } from "./runtimes/native-host.js";
import type { EncryptedSecretStore } from "./secrets.js";

// Capture the dependencies the handler wires into the review; the review itself has its own tests.
vi.mock("./learning-review.js", async (importOriginal) => ({
  ...(await importOriginal<typeof LearningReviewModule>()),
  reviewLearning: vi.fn(async () => undefined),
}));
// Reviews reuse the executor's registry; a second one would ignore the registry injected here.
vi.mock("./runtime-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRegistryModule>()),
  createRuntimeRegistry: vi.fn(() => {
    throw new Error("A second runtime registry was created.");
  }),
}));

const pins: Record<string, RuntimePin> = {
  pi: {
    runtimeKind: "pi",
    provider: "openai-compatible",
    modelId: "fixture",
    effort: "medium",
    credentialId: "connection",
    revision: 1,
  },
  "codex-app-server": {
    runtimeKind: "codex-app-server",
    provider: "openai-codex",
    modelId: "fixture-codex",
    effort: "high",
    credentialId: "native:codex-app-server",
    revision: 1,
  },
  "claude-code": {
    runtimeKind: "claude-code",
    provider: "anthropic",
    modelId: "fixture-claude",
    effort: "high",
    credentialId: "native:claude-code",
    revision: 1,
  },
  antigravity: {
    runtimeKind: "antigravity",
    provider: "antigravity",
    modelId: "gemini-3.8-flash-low",
    effort: "low",
    credentialId: "native:antigravity",
    revision: 1,
  },
  hermes: {
    runtimeKind: "hermes",
    provider: "openai-compatible",
    modelId: "fixture",
    effort: "medium",
    credentialId: "connection",
    revision: 1,
  },
};

function fixture(options: { users?: string[]; experimental?: boolean } = {}) {
  const runtimes = new Map<RuntimeKind, AgentRuntime>();
  const probes = new Map<RuntimeKind, ReturnType<typeof vi.fn>>();
  const entry = (kind: RuntimeKind) => {
    const runtime = { describe: () => ({ id: kind }) } as unknown as AgentRuntime;
    const pin = pins[kind]!;
    const probe = vi.fn(
      async (): Promise<RuntimeAvailability> => ({
        runtimeKind: kind,
        available: true,
        models: [{ id: pin.modelId!, label: pin.modelId!, efforts: [pin.effort!] }],
      }),
    );
    runtimes.set(kind, runtime);
    probes.set(kind, probe);
    return { factory: () => runtime, probe };
  };
  const kinds: RuntimeKind[] = ["pi", "codex-app-server", "claude-code", "antigravity", "hermes"];
  const registry = new RuntimeRegistry(
    Object.fromEntries(kinds.map((kind) => [kind, entry(kind)])),
  );
  const users = options.users ?? ["owner"];
  const prisma = {
    run: {
      findUnique: vi.fn(async () => ({
        userId: "owner",
        bot: {
          runtimeExperimental: options.experimental ?? true,
          computer: { kind: "desktop", providerRef: "/host/reviewed-bot" },
        },
      })),
    },
    user: { findMany: vi.fn(async () => users.map((id) => ({ id }))) },
  } as unknown as PrismaClient;
  const executor = createRunExecutor({
    prisma,
    runtimeRegistry: registry,
    web: {},
    browser: {},
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  const handlers = createBackgroundJobHandlers({
    executor,
    prisma,
    sandbox: {} as SandboxProvider,
    home: {} as AgentHomeStore,
    jobs: {} as JobPublisher,
    events: {} as ThreadEvents,
    workerId: "worker",
    runtime: runtimes.get("pi")!,
    secretStore: {} as EncryptedSecretStore,
    memoryProviders: { resolve: vi.fn(async () => null) },
  });
  const resolveRuntime = async (pin: RuntimePin) => {
    vi.mocked(reviewLearning).mockClear();
    await handlers["learning.review"]({
      runId: "reviewed-run",
      historyGeneration: 0,
      evidenceWatermark: "watermark",
      policyVersion: 1,
    } as never);
    const deps = vi.mocked(reviewLearning).mock.calls[0]![0];
    return deps.resolveRuntime!(pin);
  };
  return { prisma, runtimes, probes, resolveRuntime };
}

describe("learning review runtime wiring", () => {
  beforeEach(() => {
    vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves reviewer pins through the executor's registry instead of a second one", async () => {
    const f = fixture();
    expect(createRuntimeRegistry).not.toHaveBeenCalled();
    const selection = await f.resolveRuntime(pins["codex-app-server"]!);
    expect(selection).toEqual({
      runtime: f.runtimes.get("codex-app-server"),
      request: { controlledComparison: true },
    });
    expect(f.prisma.run.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "reviewed-run" } }),
    );
  });

  it("refuses native reviewers on a server with more than one account, before probing", async () => {
    const f = fixture({ users: ["owner", "teammate"] });
    for (const kind of ["codex-app-server", "claude-code", "antigravity"]) {
      expect(await f.resolveRuntime(pins[kind]!)).toMatchObject({
        kind: "problem",
        code: "runtime-unavailable",
        reason: NATIVE_HOST_OWNER_MESSAGE,
      });
      expect(f.probes.get(kind as RuntimeKind)).not.toHaveBeenCalled();
    }
    // A pi reviewer uses a server connection, not the host's sign-in.
    expect(await f.resolveRuntime(pins.pi!)).toEqual({
      runtime: f.runtimes.get("pi"),
      request: {},
    });
  });

  it("isolates native reviewers from the bot folder where the runtime can", async () => {
    const f = fixture();
    expect(await f.resolveRuntime(pins["claude-code"]!)).toEqual({
      runtime: f.runtimes.get("claude-code"),
      request: { controlledComparison: true },
    });
    // Antigravity cannot isolate a turn and needs the reviewed bot's host folder.
    expect(await f.resolveRuntime(pins.antigravity!)).toEqual({
      runtime: f.runtimes.get("antigravity"),
      request: { nativeCwd: "/host/reviewed-bot" },
    });
  });

  it("keeps the registry's bot checks and the Hermes refusal", async () => {
    const f = fixture({ experimental: false });
    expect(await f.resolveRuntime(pins["codex-app-server"]!)).toMatchObject({
      kind: "problem",
      reason: expect.stringContaining("Experimental"),
    });
    const hermes = await f.resolveRuntime(pins.hermes!);
    expect(hermes).toMatchObject({ kind: "problem", reason: expect.stringContaining("Hermes") });
    expect(f.probes.get("hermes")).not.toHaveBeenCalled();
  });
});
