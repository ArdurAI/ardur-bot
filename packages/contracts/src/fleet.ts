import { z } from "zod";

const measurement = z.number().finite().nonnegative().nullable();
export const CapacitySnapshotSchema = z.object({
  cpuCount: measurement,
  cpuLoad1m: measurement,
  memoryTotal: measurement,
  memoryFree: measurement,
  diskFree: measurement,
  sampledAt: z.string().datetime(),
  source: z.enum([
    "host",
    "ssh",
    "docker",
    "kubernetes-requests",
    "kubernetes-metrics",
    "not-reported",
  ]),
});
export type CapacitySnapshot = z.infer<typeof CapacitySnapshotSchema>;
export function unknownCapacity(): CapacitySnapshot {
  return {
    cpuCount: null,
    cpuLoad1m: null,
    memoryTotal: null,
    memoryFree: null,
    diskFree: null,
    sampledAt: new Date().toISOString(),
    source: "not-reported",
  };
}

export const SshSettingsSchema = z.object({
  host: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/),
  port: z.number().int().min(1).max(65535).default(22),
  user: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z_][a-zA-Z0-9_-]*[$]?$/),
  authentication: z.enum(["agent", "private-key", "tailscale"]).default("agent"),
  jumpHost: z
    .string()
    .max(320)
    .regex(/^(?:[a-zA-Z_][a-zA-Z0-9_-]*@)?[a-zA-Z0-9][a-zA-Z0-9.-]*(?::[0-9]{1,5})?$/)
    .optional(),
  baseDirectory: z
    .string()
    .max(1024)
    .regex(/^(?:~\/|\/)(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+$/)
    .refine((value) => !value.split("/").some((part) => part === ".." || part === "."))
    .default("~/.ardurbot/computers"),
});
export type SshSettings = z.infer<typeof SshSettingsSchema>;

export const EngineEndpointSchema = z
  .string()
  .max(1024)
  .refine((value) => {
    if (/^(?:unix:\/\/)?\//.test(value)) return !/[\0\r\n]/.test(value);
    try {
      const url = new URL(value);
      return (
        ["ssh:", "tcp:"].includes(url.protocol) &&
        !!url.hostname &&
        !url.password &&
        !url.search &&
        !url.hash &&
        (!url.pathname || url.pathname === "/") &&
        (url.protocol !== "tcp:" || (!url.username && url.port === "2376"))
      );
    } catch {
      return false;
    }
  }, "Choose a Unix socket, SSH endpoint, or TLS endpoint on port 2376.");

export const PlacementSettingsSchema = /* @__PURE__ */ (() =>
  z.object({
    mode: z.enum(["manual", "free-memory", "threshold"]).default("manual"),
    preferredTargetId: z.string().max(160).default("host"),
    minimumFreeGb: z.number().finite().min(0.25).max(65536).default(4),
  }))();
export type PlacementSettings = z.infer<typeof PlacementSettingsSchema>;
export const FLEET_KINDS = [
  "host",
  "docker",
  "podman",
  "kubernetes",
  "ssh",
  "tailscale",
  "default",
  "e2b",
  "daytona",
  "box",
] as const;
/** Display names for engines and providers. The host is named by its `HostLabel`. */
export const ENGINE_LABELS: Readonly<Record<string, string>> = {
  docker: "Docker",
  "remote-docker": "Docker",
  podman: "Podman",
  kubernetes: "Kubernetes",
  ssh: "SSH",
  tailscale: "Tailscale",
  e2b: "E2B",
  daytona: "Daytona",
  box: "Box",
};
export const HostLabelSchema = /* @__PURE__ */ (() => z.enum(["This Mac", "This computer"]))();
export type HostLabel = z.infer<typeof HostLabelSchema>;
export const FleetTargetSchema = /* @__PURE__ */ (() =>
  z.object({
    id: z.string(),
    name: z.string(),
    kind: z.enum(FLEET_KINDS),
    /** Rows the deployment provides, named by clients in their own language. */
    builtin: z.enum(["host", "local-docker", "default"]).optional(),
    connectionId: z.string().nullable(),
    state: z.enum(["connected", "discovered", "unavailable"]),
    capacity: CapacitySnapshotSchema,
    version: z.string().optional(),
    os: z.string().optional(),
    endpoint: z.string().optional(),
    context: z.string().optional(),
    ssh: SshSettingsSchema.optional(),
    bots: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
  }))();
export type FleetTarget = z.infer<typeof FleetTargetSchema>;
export const PlacementDecisionSchema = z.object({
  targetId: z.string(),
  targetName: z.string().optional(),
  connectionId: z.string().nullable(),
  reason: z.string(),
  fromTargetId: z.string(),
  decidedAt: z.string().datetime(),
});
export type PlacementDecision = z.infer<typeof PlacementDecisionSchema>;
export const RunPlacementSchema = z.union([
  PlacementDecisionSchema.extend({
    status: z.enum(["pending", "moving", "moved", "failed", "skipped"]),
  }),
  z.object({ status: z.literal("declined") }),
]);
export const FleetSchema = /* @__PURE__ */ (() =>
  z.object({
    targets: z.array(FleetTargetSchema),
    hostLabel: HostLabelSchema,
    placement: PlacementSettingsSchema,
    bots: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          moveAutomatically: z.boolean(),
          pending: PlacementDecisionSchema.nullable(),
        }),
      )
      .default([]),
  }))();

/** Unknown, stale, disconnected and merely discovered machines are never placement candidates. */
export function choosePlacement(
  settings: PlacementSettings,
  currentTargetId: string,
  targets: FleetTarget[],
  now = Date.now(),
): PlacementDecision | null {
  if (settings.mode === "manual") return null;
  const valid = targets.filter((target) => {
    const age = now - Date.parse(target.capacity.sampledAt);
    return (
      target.state === "connected" &&
      target.capacity.memoryFree !== null &&
      age >= -5000 &&
      age <= 30_000
    );
  });
  const current = valid.find((target) => target.id === currentTargetId);
  // A missing or unreachable current row is not a reason to leave. Free-memory and threshold
  // both stay put until that computer's own row is connected and fresh.
  if (!current) return null;
  const threshold = settings.minimumFreeGb * 1024 ** 3;
  if (settings.mode === "threshold" && current.capacity.memoryFree! >= threshold) return null;
  const ranked = [...valid].sort(
    (a, b) =>
      b.capacity.memoryFree! - a.capacity.memoryFree! ||
      (a.id === currentTargetId ? -1 : b.id === currentTargetId ? 1 : a.id.localeCompare(b.id)),
  );
  const preferred = valid.find(
    (target) =>
      target.id === settings.preferredTargetId && target.capacity.memoryFree! >= threshold,
  );
  const best = settings.mode === "threshold" && preferred ? preferred : ranked[0];
  if (
    !best ||
    best.id === currentTargetId ||
    best.capacity.memoryFree! <= current.capacity.memoryFree!
  )
    return null;
  if (settings.mode === "threshold" && best.capacity.memoryFree! < threshold) return null;
  const reason =
    settings.mode === "threshold"
      ? `${current.name} had ${(current.capacity.memoryFree! / 1024 ** 3).toFixed(1)} GB free`
      : "it had the most free memory";
  return {
    targetId: best.id,
    targetName: best.name,
    connectionId: best.connectionId,
    reason,
    fromTargetId: currentTargetId,
    decidedAt: new Date(now).toISOString(),
  };
}
