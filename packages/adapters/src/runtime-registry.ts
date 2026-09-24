import type { AgentRuntime } from "@ardurbot/adapter-kit";
import type {
  RuntimeAvailability,
  RuntimeKind,
  RuntimePin,
  RuntimeProblem,
} from "@ardurbot/contracts";
import { runtimePinProblem } from "@ardurbot/contracts";
import { ClaudeCodeRuntime, probeClaude } from "./runtimes/claude-code-runtime.js";
import { CodexAppServerRuntime, probeCodex } from "./runtimes/codex-app-server-runtime.js";

type RuntimeEntry = { factory: () => AgentRuntime; probe: () => Promise<RuntimeAvailability> };
export class RuntimeRegistry {
  constructor(private readonly entries: Partial<Record<RuntimeKind, RuntimeEntry>>) {}
  async resolve(
    pin: RuntimePin,
    computerKind?: string,
    experimental = false,
  ): Promise<{ runtime: AgentRuntime; availability: RuntimeAvailability } | RuntimeProblem> {
    const entry = this.entries[pin.runtimeKind];
    if (!entry)
      return runtimePinProblem(
        pin,
        "runtime-unavailable",
        "The pinned runtime is unavailable — connect it or change the pin.",
      );
    if (pin.runtimeKind !== "pi" && computerKind !== "desktop")
      return runtimePinProblem(
        pin,
        "runtime-unsupported-computer",
        `${pin.runtimeKind === "claude-code" ? "Claude Code" : "Codex"} runs on host computers for now — change the bot's computer or its runtime.`,
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
        reason: "The pinned runtime is unavailable — connect it or change the pin.",
        models: [],
      }),
    );
    if (!availability.available)
      return runtimePinProblem(
        pin,
        "runtime-unavailable",
        availability.reason ?? "The pinned runtime is unavailable — connect it or change the pin.",
      );
    if (pin.runtimeKind !== "pi") {
      const model = availability.models.find((entry) => entry.id === pin.modelId);
      if (!model)
        return runtimePinProblem(
          pin,
          "pin-model-unknown",
          "The pinned model is unavailable in this runtime.",
        );
      if (!model.efforts.includes(pin.effort ?? ""))
        return runtimePinProblem(
          pin,
          "pin-effort-unsupported",
          "This runtime cannot attest the pinned effort.",
        );
    }
    return { runtime: entry.factory(), availability };
  }
}

export function createRuntimeRegistry(pi: AgentRuntime) {
  const claude = new ClaudeCodeRuntime();
  const codex = new CodexAppServerRuntime();
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
  });
}

export async function nativeRuntimeAvailability(kind: RuntimeKind): Promise<RuntimeAvailability> {
  if (kind === "pi") return { runtimeKind: kind, available: true, models: [] };
  if (process.platform === "win32")
    return {
      runtimeKind: kind,
      available: false,
      models: [],
      reason: "Native runtimes support macOS and Linux host computers for now.",
    };
  return kind === "claude-code" ? probeClaude() : probeCodex();
}
