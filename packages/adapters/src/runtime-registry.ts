import { existsSync } from "node:fs";
import type { AdapterContext, AgentRunRequest, AgentRuntime } from "@ardurbot/adapter-kit";
import type {
  RuntimeAvailability,
  RuntimeKind,
  RuntimePin,
  RuntimeProblem,
} from "@ardurbot/contracts";
import {
  nativeRuntimeHealthKeys,
  runtimeNames,
  runtimePinProblem,
  validateAntigravityPin,
} from "@ardurbot/contracts";
import type { BrokerScope, HermesProviderBroker } from "./hermes-provider-broker.js";
import { RemoteHostRuntime } from "./remote-host-runtime.js";
import { createHostClient, usesHostBridge } from "./remote-host-sandbox.js";
import { AntigravityRuntime, probeAntigravity } from "./runtimes/antigravity-runtime.js";
import { ClaudeCodeRuntime, probeClaude } from "./runtimes/claude-code-runtime.js";
import { CodexAppServerRuntime, probeCodex } from "./runtimes/codex-app-server-runtime.js";

type RuntimeEntry = { factory: () => AgentRuntime; probe: () => Promise<RuntimeAvailability> };
export class RuntimeRegistry {
  constructor(private readonly entries: Partial<Record<RuntimeKind, RuntimeEntry>>) {}
  async resolve(
    pin: RuntimePin,
    computerKind?: string,
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
    if (pin.runtimeKind !== "pi" && computerKind !== "desktop")
      return runtimePinProblem(
        pin,
        "runtime-unsupported-computer",
        `${runtimeNames[pin.runtimeKind]} runs on host computers for now — change the bot's computer or its runtime.`,
      );
    if (pin.runtimeKind !== "pi" && !experimental)
      return runtimePinProblem(
        pin,
        "runtime-unavailable",
        "This runtime is experimental — enable Experimental in the bot's settings or change the pin.",
      );
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
  computer: { kind: string; providerRef: string | null } | null | undefined,
): DetachedRuntime["request"] {
  if (pin.runtimeKind === "pi") return {};
  if (pin.runtimeKind === "antigravity")
    return {
      nativeCwd: computer?.kind === "desktop" ? (computer.providerRef ?? undefined) : undefined,
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
  return new RuntimeRegistry({
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
  });
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
    const { localHermesInstallCandidate, probeHermesInstall } = await import(
      "@ardurbot/host-runtime/runtimes/hermes-install"
    );
    const install = localHermesInstallCandidate();
    if (!install || !existsSync(install)) {
      return {
        runtimeKind: "hermes",
        available: false,
        models: [],
        reason: "Hermes is not installed on this computer.",
      };
    }
    try {
      probeHermesInstall(install);
      return { runtimeKind: "hermes", available: true, models: [] };
    } catch {
      return {
        runtimeKind: "hermes",
        available: false,
        models: [],
        reason: "The Hermes install on this computer failed its safety check.",
      };
    }
  }
  return kind === "claude-code"
    ? probeClaude()
    : kind === "codex-app-server"
      ? probeCodex()
      : probeAntigravity(undefined, undefined, refresh);
}
