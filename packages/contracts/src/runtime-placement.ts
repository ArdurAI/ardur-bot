import type { ComputerConnectionSettings } from "./computer-connections.js";
import { COMPUTER_KINDS } from "./computer-connections.js";
import type { SandboxKind } from "./ids.js";
import type { RuntimeKind } from "./runtime-pins.js";

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

/** Host authority requires a connectionless row; unresolved connections never grant it. */
export function computerRunsOnHost(location: RuntimeComputerLocation | null | undefined): boolean {
  return (
    !!location && location.connectionId == null && computerExecutionKind(location) === "desktop"
  );
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
