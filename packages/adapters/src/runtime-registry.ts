import type { AdapterContext, AgentRunRequest, AgentRuntime } from "@ardurbot/adapter-kit";
import type {
  RuntimeAvailability,
  RuntimeComputerLocation,
  RuntimeKind,
  RuntimePin,
  RuntimeProblem,
} from "@ardurbot/contracts";
import {
  computerRunsOnHost,
  nativeRuntimeHealthKeys,
  runtimeCapabilityReport,
  runtimePinProblem,
  validateAntigravityPin,
} from "@ardurbot/contracts";
import type { BrokerScope, HermesProviderBroker } from "./hermes-provider-broker.js";
import { setHermesProviderStream } from "./hermes-provider-broker.js";
import { catalogModels, PiAgentRuntime } from "./pi-runtime.js";
import { canBotRun } from "./pin-resolution.js";
import { RemoteHostRuntime } from "./remote-host-runtime.js";
import { createHostClient, usesHostBridge } from "./remote-host-sandbox.js";
import { AntigravityRuntime, probeAntigravity } from "./runtimes/antigravity-runtime.js";
import { ClaudeCodeRuntime, probeClaude } from "./runtimes/claude-code-runtime.js";
import { CodexAppServerRuntime, probeCodex } from "./runtimes/codex-app-server-runtime.js";

type RuntimeEntry = {
  factory: () => AgentRuntime;
  probe: () => Promise<RuntimeAvailability>;
  evidence?: unknown;
};
export class RuntimeRegistry {
  constructor(private readonly entries: Partial<Record<RuntimeKind, RuntimeEntry>>) {}
  capabilityReport(kind: RuntimeKind, runtimeVersion: string | null = null) {
    const entry = this.entries[kind];
    if (!entry) throw new Error("Runtime is not registered");
    const descriptor = entry.factory().describe();
    const capabilities = descriptor.capabilities;
    return runtimeCapabilityReport({
      runtimeKind: kind,
      adapterId: descriptor.id,
      adapterVersion: descriptor.adapterVersion,
      runtimeVersion,
      evidence: entry.evidence,
      declared: {
        streaming: capabilities.streaming,
        instructions: capabilities.instructions,
        cancellation: capabilities.cancellation,
        "tool-authorization": capabilities.toolAuthorization,
        usage: capabilities.usage,
      },
    });
  }
  async resolve(
    pin: RuntimePin,
    computerLocation?: string | RuntimeComputerLocation,
    experimental = false,
    connection?: { credentialId: string; provider: string; modelId: string; effort: string },
  ): Promise<{ runtime: AgentRuntime; availability: RuntimeAvailability } | RuntimeProblem> {
    const entry = this.entries[pin.runtimeKind];
    if (!entry)
      return runtimePinProblem(
        pin,
        "runtime-unavailable",
        "The pinned runtime is unavailable — change the pin.",
      );
    const problem = canBotRun({
      pin,
      placement: {
        computer:
          typeof computerLocation === "string"
            ? { kind: computerLocation }
            : (computerLocation ?? {}),
        experimental,
      },
    });
    if (problem) return problem;
    const availability = await entry.probe().catch(
      (): RuntimeAvailability => ({
        runtimeKind: pin.runtimeKind,
        available: false,
        reason: "The pinned runtime is unavailable — change the pin.",
        models: [],
      }),
    );
    if (
      !availability.available &&
      !(
        pin.runtimeKind === "antigravity" &&
        availability.signInStatus === "signed-out" &&
        availability.catalogStale === false
      )
    )
      return runtimePinProblem(
        pin,
        "runtime-unavailable",
        availability.reason ?? "The pinned runtime is unavailable — change the pin.",
        availability.reasonId,
      );
    if (pin.runtimeKind === "hermes") {
      if (
        !connection ||
        connection.credentialId !== pin.credentialId ||
        connection.provider !== pin.provider ||
        connection.modelId !== pin.modelId ||
        connection.effort !== pin.effort
      )
        return runtimePinProblem(
          pin,
          "pin-credential-missing",
          "The pinned Hermes connection changed.",
        );
    } else if (pin.runtimeKind !== "pi") {
      const model = availability.models.find((entry) => entry.id === pin.modelId);
      if (!model)
        return runtimePinProblem(
          pin,
          "pin-model-unknown",
          "The pinned model is unavailable in this runtime.",
        );
      if (pin.runtimeKind === "antigravity") {
        const invalid = validateAntigravityPin(pin, availability.models);
        if (invalid) return invalid;
      } else if (!model.efforts.includes(pin.effort ?? ""))
        return runtimePinProblem(
          pin,
          "pin-effort-unsupported",
          "This runtime cannot attest the pinned effort.",
        );
    }
    return { runtime: entry.factory(), availability };
  }
}

import { LocalHermesRuntime } from "./runtimes/local-hermes-runtime.js";
/** A runtime for a one-off call outside a run, with the request fields it must run with. */
export type DetachedRuntime = {
  runtime: AgentRuntime;
  request: Pick<AgentRunRequest, "nativeCwd" | "controlledComparison">;
};

/**
 * Isolation for a one-off native call outside a run, such as a learning review. Codex
 * and Claude Code run as in a controlled comparison, without the bot folder's
 * instructions, settings, skills or saved memories. Antigravity cannot isolate a turn
 * and refuses to start without the bot's host folder.
 */
export function detachedRuntimeRequest(
  pin: RuntimePin,
  computer: (RuntimeComputerLocation & { providerRef: string | null }) | null | undefined,
): DetachedRuntime["request"] {
  if (pin.runtimeKind === "pi") return {};
  if (pin.runtimeKind === "antigravity")
    return {
      nativeCwd: computerRunsOnHost(computer) ? (computer?.providerRef ?? undefined) : undefined,
    };
  return { controlledComparison: true };
}

export function createRuntimeRegistry(
  pi: AgentRuntime,
  brokerForTurn?: (
    request: AgentRunRequest,
    context: Partial<AdapterContext>,
    fence: { operationId: string; hostGeneration: string },
  ) => Promise<{ broker: HermesProviderBroker; scope: BrokerScope }>,
) {
  // The broker's translated route streams through Ardur's provider layer with
  // the same registry the built-in runtime uses; the connection's resolved key
  // travels in the broker's catalog binding, never to the Hermes process.
  setHermesProviderStream((model, context, options) =>
    catalogModels().streamSimple(model, context, options),
  );
  return new RuntimeRegistry(runtimeEntries(pi, brokerForTurn));
}

function runtimeEntries(
  pi: AgentRuntime,
  brokerForTurn?: Parameters<typeof createRuntimeRegistry>[1],
) {
  const client = usesHostBridge() ? createHostClient() : undefined;
  const claude = client ? new RemoteHostRuntime(client, "claude-code") : new ClaudeCodeRuntime();
  const codex = client
    ? new RemoteHostRuntime(client, "codex-app-server")
    : new CodexAppServerRuntime();
  const antigravity = client
    ? new RemoteHostRuntime(client, "antigravity")
    : new AntigravityRuntime();
  const hermes = client
    ? new RemoteHostRuntime(client, "hermes", brokerForTurn)
    : new LocalHermesRuntime(brokerForTurn);
  return {
    pi: {
      factory: () => pi,
      probe: async () => ({
        runtimeKind: "pi",
        available: true,
        version: pi.describe().adapterVersion,
        models: [],
      }),
    },
    "claude-code": { factory: () => claude, probe: () => nativeRuntimeAvailability("claude-code") },
    "codex-app-server": {
      factory: () => codex,
      probe: () => nativeRuntimeAvailability("codex-app-server"),
    },
    antigravity: {
      factory: () => antigravity,
      probe: () => nativeRuntimeAvailability("antigravity"),
    },
    hermes: {
      factory: () => hermes,
      probe: () => nativeRuntimeAvailability("hermes"),
    },
  } satisfies Partial<Record<RuntimeKind, RuntimeEntry>>;
}

/** Metadata only: no availability probe, health request, model call or runtime launch. */
export function registeredRuntimeCapabilityReport(kind: RuntimeKind) {
  return new RuntimeRegistry(runtimeEntries(new PiAgentRuntime())).capabilityReport(kind);
}

export async function nativeRuntimeAvailability(
  kind: RuntimeKind,
  refresh = false,
): Promise<RuntimeAvailability> {
  if (kind === "pi") return { runtimeKind: kind, available: true, models: [] };
  if (usesHostBridge()) {
    const health = await createHostClient().health();
    return (
      health?.[nativeRuntimeHealthKeys[kind]] ?? {
        runtimeKind: kind,
        available: false,
        models: [],
        reason:
          health && kind === "antigravity"
            ? "Update Ardur on the connected computer to use Antigravity."
            : "Host service is not running — open the desktop app.",
      }
    );
  }
  if (kind === "hermes") {
    if (process.platform === "win32") {
      return {
        runtimeKind: "hermes",
        available: false,
        models: [],
        reason: "Hermes isn't available on Windows yet.",
      };
    }
    const {
      hermesInstallProgress,
      localHermesInstallCandidate,
      localHermesRoot,
      probeHermesInstall,
    } = await import("@ardurbot/host-runtime/runtimes/hermes-install");
    const candidate = localHermesInstallCandidate();
    // An explicit install belongs to the operator, so a failed check never offers reinstall.
    const managed = !process.env.ARDUR_HERMES_INSTALL;
    const progress = hermesInstallProgress(localHermesRoot());
    let available = false;
    if (candidate) {
      try {
        probeHermesInstall(candidate);
        available = true;
      } catch {
        available = false;
      }
    }
    const install = available
      ? progress?.state === "ready"
        ? { state: "ready" as const }
        : undefined
      : !managed
        ? undefined
        : progress?.state === "installing"
          ? progress
          : progress
            ? { state: "failed" as const }
            : candidate
              ? { state: "absent" as const }
              : undefined;
    return {
      runtimeKind: "hermes",
      available,
      models: [],
      ...(!available
        ? {
            reason: candidate
              ? "The Hermes install on this computer failed its safety check."
              : "Hermes is not installed on this computer.",
          }
        : {}),
      ...(install ? { install } : {}),
    };
  }
  return kind === "claude-code"
    ? probeClaude()
    : kind === "codex-app-server"
      ? probeCodex()
      : probeAntigravity(undefined, undefined, refresh);
}
