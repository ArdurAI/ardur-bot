import type { ComputerConnectionSettings } from "./computer-connections.js";
import { COMPUTER_KINDS } from "./computer-connections.js";
import type { SandboxKind } from "./ids.js";
import type { RuntimeKind } from "./runtime-pins.js";

export type NewBotLocation = "host" | "sandbox";

/** The deployment's existing computerHost setting is the single default override. */
export const NEW_BOT_LOCATION_POLICY = {
  default: "host",
  unavailableHost: "sandbox",
  overrides: { docker: "sandbox", "this-mac": "host" },
} as const satisfies {
  default: NewBotLocation;
  unavailableHost: NewBotLocation;
  overrides: Record<"docker" | "this-mac", NewBotLocation>;
};

export function defaultNewBotLocation(input: {
  isDeploymentOwner: boolean;
  hostConnected: boolean;
  hostPaired: boolean;
  computerHost?: "docker" | "this-mac" | null;
}): NewBotLocation {
  const preferred = input.computerHost
    ? NEW_BOT_LOCATION_POLICY.overrides[input.computerHost]
    : NEW_BOT_LOCATION_POLICY.default;
  return preferred === "host" &&
    !(input.isDeploymentOwner && input.hostConnected && input.hostPaired)
    ? NEW_BOT_LOCATION_POLICY.unavailableHost
    : preferred;
}

export type RuntimeComputerLocation = {
  kind?: string | null;
  connectionId?: string | null;
  connectionSettings?: Pick<ComputerConnectionSettings, "engine"> | null;
};

/** A saved connection owns the location, even when a legacy row still says desktop. */
export function computerExecutionKind(location: RuntimeComputerLocation): SandboxKind | null {
  const kind =
    location.connectionId !== undefined && location.connectionId !== null
      ? location.connectionSettings
        ? computerConnectionKind(location.connectionSettings)
        : null
      : location.kind;
  return kind && Object.hasOwn(COMPUTER_KINDS, kind) ? (kind as SandboxKind) : null;
}

export function computerConnectionKind(
  settings: Pick<ComputerConnectionSettings, "engine">,
): SandboxKind {
  return settings.engine === "docker" || settings.engine === "podman"
    ? "remote-docker"
    : settings.engine;
}

/** Placement policy only: ownership, health, models and Experimental remain separate checks. */
export const RUNTIME_PLACEMENT_RULES = {
  pi: { locations: Object.keys(COMPUTER_KINDS) as SandboxKind[] },
  "codex-app-server": { locations: ["desktop"] },
  "claude-code": { locations: ["desktop"] },
  antigravity: { locations: ["desktop"] },
  hermes: { locations: ["desktop"] },
} as const satisfies Record<RuntimeKind, { locations: readonly SandboxKind[] }>;

export function runtimeSupportsLocation(
  runtime: RuntimeKind,
  location: RuntimeComputerLocation,
): boolean {
  const kind = computerExecutionKind(location);
  const allowed: readonly SandboxKind[] = RUNTIME_PLACEMENT_RULES[runtime].locations;
  return kind !== null && allowed.includes(kind);
}
