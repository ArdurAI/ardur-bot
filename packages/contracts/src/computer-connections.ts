import { z } from "zod";
import { isComputerImageReference, MAX_COMPUTER_IMAGE_LENGTH } from "./computer-image.js";
import { ComputerProfileSchema } from "./computer-profiles.js";
import type { ComputerMode, ComputerStatus } from "./domain.js";
import { EngineEndpointSchema, SshSettingsSchema } from "./fleet.js";
import type { SandboxKind } from "./ids.js";

export const ComputerEngineUnavailableSchema = z.object({
  error: z.literal("engine-unavailable"),
  engine: z.enum(["docker", "podman"]),
  socket: z
    .string()
    .min(1)
    .max(1024)
    .regex(/^[^\r\n\0]+$/),
});
export class ComputerEngineUnavailableError extends Error {
  constructor(failure: z.infer<typeof ComputerEngineUnavailableSchema>) {
    const name = failure.engine === "podman" ? "Podman" : "Docker";
    const application = failure.engine === "podman" ? "Podman" : "Docker Desktop";
    super(
      `${name} is not running or not reachable at ${failure.socket}. Start ${application} and try again.`,
    );
  }
}

const quantity = z.string().regex(/^\d+(?:\.\d+)?(?:m|[KMGT]i?)?$/);
/** A Kubernetes DNS-1123 label, as used for namespace and Secret names here. */
const dnsLabel = z.string().regex(/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/);
const imageReference = z
  .string()
  .max(MAX_COMPUTER_IMAGE_LENGTH)
  .refine(isComputerImageReference, "Enter an image reference, such as registry/computer:tag.");
export const ComputerConnectionSettingsSchema = z.object({
  engine: z.enum(["docker", "podman", "kubernetes", "ssh"]),
  endpoint: EngineEndpointSchema.optional(),
  ssh: SshSettingsSchema.optional(),
  dockerContext: z.string().min(1).max(256).optional(),
  hostSecretId: z.string().uuid().optional(),
  socket: z.string().max(1024).optional(),
  context: z.string().max(256).optional(),
  namespace: dnsLabel.default("ardurbot"),
  storageSize: quantity.default("10Gi"),
  storageClass: z.string().max(256).optional(),
  cpuRequest: quantity.default("250m"),
  cpuLimit: quantity.default("2"),
  memoryRequest: quantity.default("256Mi"),
  memoryLimit: quantity.default("2Gi"),
  /** Images for a private or air-gapped registry; unset uses the deployment's resolution. */
  standardImage: imageReference.optional(),
  developerImage: imageReference.optional(),
  /** An existing image pull Secret in the namespace; the app never creates Secrets. */
  imagePullSecret: z
    .string()
    .regex(/^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/)
    .optional(),
});
export type ComputerConnectionSettings = z.infer<typeof ComputerConnectionSettingsSchema>;
export const ComputerConnectionInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  settings: ComputerConnectionSettingsSchema,
  kubeconfig: z
    .string()
    .min(1)
    .max(1024 * 1024)
    .optional(),
  kubeconfigPath: z.string().min(1).max(1024).optional(),
  privateKeyPath: z.string().min(1).max(4096).optional(),
  tlsPaths: z
    .object({ ca: z.string().max(4096), cert: z.string().max(4096), key: z.string().max(4096) })
    .optional(),
});
export const HOST_MOVE_UNAVAILABLE_MESSAGE =
  "Moving a computer onto the machine running Ardur is not available yet. Choose a saved connection or keep the current engine.";
/** A computer can never be moved onto the host: one typed error, detected by class, not text. */
export class HostMoveUnavailableError extends Error {
  constructor() {
    super(HOST_MOVE_UNAVAILABLE_MESSAGE);
    this.name = "HostMoveUnavailableError";
  }
}
/**
 * ORPC error `data.code`s a client decides on, never by comparing message text: a computer
 * cannot reach its own (genuinely missing) engine, or cannot be moved onto the host.
 */
export const ENGINE_MISSING_CODE = "engine-missing";
export const HOST_MOVE_UNAVAILABLE_CODE = "host-move-unavailable";
export const FLEET_ACTIVE_RUN_CONFLICT_CODE = "fleet-active-runs";
export const FLEET_PINNED_BOTS_CONFLICT_CODE = "fleet-pinned-bots";
export const ISOLATED_COMPUTER_UNAVAILABLE_CODE = "isolated-computer-unavailable";
export class IsolatedComputerUnavailableError extends Error {
  constructor() {
    super("Set up a container for isolated work.");
    this.name = "IsolatedComputerUnavailableError";
  }
}
const ComputerConfigurationFieldsSchema = z.object({
  botId: z.string().min(1),
  imageProfile: ComputerProfileSchema.optional(),
  /** Omitted keeps the computer where it is; null chooses the deployment default. */
  connectionId: z.string().nullable().optional(),
  confirmed: z.boolean().default(false),
});
/** A configuration that changes neither the profile nor the connection is not a request. */
export const ComputerConfigurationSchema = ComputerConfigurationFieldsSchema.refine(
  (configuration) =>
    configuration.imageProfile !== undefined || configuration.connectionId !== undefined,
  { message: "Choose an image profile or a connection to change." },
);
type ComputerKindFacts = {
  location: "Container" | "This computer" | "Remote computer" | "Hosted sandbox" | "Test computer";
  boundary: "container" | "host" | "account" | "hosted" | "test";
  isolated: boolean;
  capabilities: { graphical: boolean; interactiveTerminal: boolean };
  policyFields: readonly ("cpu" | "memory" | "disk" | "network")[];
};

/** Describes execution boundaries, not proof that a requested limit was applied. */
export const COMPUTER_KINDS = {
  docker: {
    location: "Container",
    boundary: "container",
    isolated: true,
    capabilities: { graphical: true, interactiveTerminal: true },
    policyFields: ["cpu", "memory", "network"],
  },
  "remote-docker": {
    location: "Container",
    boundary: "container",
    isolated: true,
    capabilities: { graphical: false, interactiveTerminal: true },
    policyFields: ["cpu", "memory", "network"],
  },
  kubernetes: {
    location: "Container",
    boundary: "container",
    isolated: true,
    capabilities: { graphical: false, interactiveTerminal: false },
    policyFields: ["cpu", "memory", "network"],
  },
  desktop: {
    location: "This computer",
    boundary: "host",
    isolated: false,
    capabilities: { graphical: false, interactiveTerminal: false },
    policyFields: [],
  },
  ssh: {
    location: "Remote computer",
    boundary: "account",
    isolated: false,
    capabilities: { graphical: false, interactiveTerminal: true },
    policyFields: [],
  },
  e2b: {
    location: "Hosted sandbox",
    boundary: "hosted",
    isolated: true,
    capabilities: { graphical: true, interactiveTerminal: false },
    policyFields: [],
  },
  daytona: {
    location: "Hosted sandbox",
    boundary: "hosted",
    isolated: true,
    capabilities: { graphical: true, interactiveTerminal: false },
    policyFields: [],
  },
  box: {
    location: "Hosted sandbox",
    boundary: "hosted",
    isolated: true,
    capabilities: { graphical: true, interactiveTerminal: false },
    policyFields: [],
  },
  fake: {
    location: "Test computer",
    boundary: "test",
    isolated: false,
    capabilities: { graphical: true, interactiveTerminal: false },
    policyFields: [],
  },
} as const satisfies Record<SandboxKind, ComputerKindFacts>;

export function computerKindFacts(kind: string): ComputerKindFacts | null {
  return Object.hasOwn(COMPUTER_KINDS, kind) ? COMPUTER_KINDS[kind as SandboxKind] : null;
}

export function computerCapabilities(kind: string) {
  return computerKindFacts(kind)?.capabilities ?? { graphical: false, interactiveTerminal: false };
}

export const COMPUTER_BOUNDARY_MESSAGES = {
  container: "Separate home; can reach allowed network services and granted credentials.",
  host: "Runs as you; can use your files and signed-in tools",
  account: "Uses that account's permissions.",
  hosted: "Runs at the configured provider; can use granted credentials and network access.",
  test: "For testing only; not an isolation boundary.",
} as const;

export function computerModeFacts(mode: ComputerMode) {
  return {
    sharing: mode === "dedicated" ? "Only this bot" : "Shared with team",
    sharingWarning: mode === "team" ? "Bots share files and installed tools" : null,
    scope: mode === "team" ? "team" : "bot",
  } as const;
}

export const COMPUTER_STATES = {
  stopped: "Stopped",
  booting: "Starting",
  running: "Running",
  suspending: "Paused for an update",
  suspended: "Sleeping",
  error: "Could not start",
} as const satisfies Record<ComputerStatus["state"], string>;

export function computerRuntimeSummary(
  status: Pick<ComputerStatus, "kind" | "mode" | "state">,
  mode: ComputerMode = status.mode,
) {
  const facts = computerKindFacts(status.kind);
  if (!facts) return null;
  return {
    ...facts,
    reach: COMPUTER_BOUNDARY_MESSAGES[facts.boundary],
    ...computerModeFacts(mode),
    state: status.state,
    stateLabel: COMPUTER_STATES[status.state],
  } as const;
}

/** Configuration availability is not engine health; provisioning still validates the pin. */
export function recommendedContainer(
  deploymentKind: string,
  connections: readonly { id: string; settings: Pick<ComputerConnectionSettings, "engine"> }[],
): { connectionId: string | null } | null {
  if (computerKindFacts(deploymentKind)?.boundary === "container") return { connectionId: null };
  const connection = connections.find((entry) =>
    ["docker", "podman", "kubernetes"].includes(entry.settings.engine),
  );
  return connection ? { connectionId: connection.id } : null;
}

export const ComputerReplacementConfigurationSchema = ComputerConfigurationFieldsSchema.omit({
  botId: true,
}).extend({ networkEgress: z.boolean().optional(), confirmed: z.literal(true) });
