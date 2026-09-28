import type { FleetTarget } from "@ardurbot/contracts";
import type { SetupDetail } from "@ardurbot/contracts/desktop-setup";
import type { FleetDiscoveryReport } from "@ardurbot/host-runtime/fleet/discovery";
import type { FleetProcess } from "@ardurbot/host-runtime/fleet/process";
import { discoverFleetReport, systemFleetProcess } from "../fleet-discovery.js";
import type { SetupStep } from "./engine.js";
import { SetupStepFailure } from "./engine.js";

export function fleetStateCode(state: FleetTarget["state"] | "unknown"): string {
  return state === "connected" || state === "discovered" || state === "unavailable"
    ? `target-${state}`
    : "target-unknown";
}

/** Target labels are generic: endpoint, context, peer and host names stay out of the journal. */
function fleetDetails(targets: FleetTarget[]): SetupDetail[] {
  if (targets.length === 0)
    return [{ code: "no-optional-computers", text: "No optional computers found" }];
  const counts = new Map<string, number>();
  return targets.slice(0, 12).map((target) => {
    const label =
      target.kind === "kubernetes"
        ? "Kubernetes"
        : target.kind === "tailscale"
          ? "Tailscale"
          : target.kind === "podman"
            ? "Podman"
            : "Docker";
    const count = (counts.get(label) ?? 0) + 1;
    counts.set(label, count);
    return { code: fleetStateCode(target.state), text: `${label} ${count}` };
  });
}

export function enginesGuidedStep(deps: {
  now(): number;
  processes?: FleetProcess;
  discover?: (processes: FleetProcess, signal: AbortSignal) => Promise<FleetDiscoveryReport>;
  cancelServices?: () => Promise<void>;
}): SetupStep {
  let found: FleetDiscoveryReport | null = null;
  const processes = deps.processes ?? systemFleetProcess;
  const discover = deps.discover ?? discoverFleetReport;
  const rediscover = async (signal: AbortSignal) => {
    found = await discover(processes, signal);
    if (found.timedOut) throw new SetupStepFailure("discovery-timeout");
    if (found.failed) throw new SetupStepFailure("discovery-failed");
    return found;
  };
  return {
    id: "engines",
    revision: 1,
    requires: ["services"],
    canSkip: true,
    check: async () => ({ kind: "needed", reasonCode: "optional-computers-unchecked" }),
    recheck: async (_, signal) => {
      const report = await rediscover(signal);
      return {
        kind: "satisfied",
        checkedAt: deps.now(),
        evidence: "local-fleet-discovery",
        details: fleetDetails(report.targets),
      };
    },
    run: async (_, signal) => {
      await rediscover(signal);
      return { kind: "verified", proof: "local-fleet-discovery" };
    },
    verify: async () =>
      found && !found.timedOut && !found.failed
        ? {
            kind: "satisfied",
            checkedAt: deps.now(),
            evidence: "local-fleet-discovery",
            details: fleetDetails(found.targets),
          }
        : { kind: "blocked", reasonCode: "fleet-discovery-failed" },
    cancel: async () => {
      found = null;
      await deps.cancelServices?.();
    },
  };
}
