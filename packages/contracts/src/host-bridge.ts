import * as z from "zod";
import { BoardRunSchema } from "./board.js";
import { HostIntegrationSchema } from "./host-integrations.js";
import { IDE_FILE_BYTES } from "./ide.js";
import {
  RuntimeAvailabilitySchema,
  RuntimeInfoSchema,
  RuntimePinSchema,
  RuntimeProblemSchema,
} from "./runtime-pins.js";

export const HOST_BRIDGE_VERSION = 1;
export const HOST_FRAME_BYTES = 256 * 1024;
export const HOST_TOTAL_BYTES = 8 * 1024 * 1024;
export const HOST_FILE_BYTES = 128 * 1024;
// Only explicit owner editor writes may carry a larger request. Stream frames keep their limit.
export const HOST_WRITE_FRAME_BYTES = Math.ceil(IDE_FILE_BYTES / 3) * 4 + 8192;
export const HOST_IN_FLIGHT = 4;
export const HOST_WINDOW = 8;
export const HOST_TOOLS = [
  "git",
  "gh",
  "glab",
  "kubectl",
  "helm",
  "docker",
  "podman",
  "aws",
  "gcloud",
  "az",
  "terraform",
  "node",
  "pnpm",
  "npm",
  "python3",
  "uv",
  "go",
  "cargo",
  "claude",
  "codex",
  "ollama",
] as const;
export const HostEnvironmentSchema = z.strictObject({
  tools: z
    .array(
      z.strictObject({
        name: z.enum(HOST_TOOLS),
        version: z
          .string()
          .max(40)
          .regex(/^\d+\.\d+(?:\.\d+)?$/)
          .optional(),
        status: z.enum(["signed in", "not checked"]),
        context: z.string().max(160).optional(),
      }),
    )
    .max(HOST_TOOLS.length),
  diagnostic: z.string().max(512).optional(),
});
export type HostEnvironment = z.infer<typeof HostEnvironmentSchema>;
export function hostEnvironmentNote(environment: HostEnvironment) {
  const tools = environment.tools
    .map(
      (tool) =>
        `${tool.name}${tool.version ? ` ${tool.version}` : ""} (${tool.context ? `context: ${JSON.stringify(tool.context)}; sign-in not checked` : tool.status})`,
    )
    .join(", ");
  return `This computer uses the owner's tools and saved CLI sign-ins. Tools on this computer: ${tools || "none detected"}. Commands start in registered folders; Ask-first rules apply to consequential commands.${environment.diagnostic ? ` ${environment.diagnostic}.` : ""}`;
}
const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9_-]+$/);
const text = z.string().max(128 * 1024);
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((s) => !s.includes("\0") && !s.split(/[/\\]/u).includes(".."));
export const HostScopeSchema = z.strictObject({ userId: id, spaceId: id, botId: id, runId: id });
export type HostScope = z.infer<typeof HostScopeSchema>;
const tool = z.strictObject({
  name: z.string().max(160),
  description: text,
  inputSchema: z.record(z.string(), z.unknown()),
  route: z.unknown().optional(),
});
export const HostTurnSchema = z.strictObject({
  controlledComparison: z.boolean().optional(),
  botId: id,
  runId: id,
  threadId: id,
  prompt: text,
  instructions: text,
  history: z
    .array(
      z.strictObject({
        id: z.string().optional(),
        role: z.enum(["user", "assistant", "system"]),
        content: text,
      }),
    )
    .max(512),
  nativeSession: RuntimeInfoSchema.optional(),
  nativeCwd: path.optional(),
  sourceMessageId: z.string().nullable().optional(),
  currentTurnImages: z
    .array(
      z.strictObject({
        name: z.string().max(256),
        mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]),
        data: z.string().max(HOST_FILE_BYTES * 2),
      }),
    )
    .max(8)
    .optional(),
  tools: z.union([z.literal("none"), z.array(tool).max(256)]),
  model: z.strictObject({
    runtimePin: RuntimePinSchema,
    provider: z.string().max(160),
    id: z.string().max(256),
    thinkingLevel: z
      .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
      .nullable()
      .optional(),
  }),
  allowSilentEmpty: z.boolean().optional(),
  emptyResponseText: text.optional(),
});
export type HostTurn = z.infer<typeof HostTurnSchema>;
export const HostMcpRegistrationSchema = z.strictObject({
  redactions: z.array(z.string().max(4096)).max(256).default([]),
  serverId: id,
  userId: id,
  spaceId: id,
  revision: z.number().int().positive(),
  command: z.string().min(1).max(512),
  args: z.array(z.string().max(2048)).max(64),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(4096)),
  cwd: path,
});
export type HostMcpRegistration = z.infer<typeof HostMcpRegistrationSchema>;
const mcpTarget = { serverId: id, revision: z.number().int().positive() };
export const HostOperationSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("board.run"), request: BoardRunSchema }),
  z.strictObject({ op: z.literal("mcp.tools"), ...mcpTarget }),
  z.strictObject({
    op: z.literal("mcp.call"),
    ...mcpTarget,
    name: z.string().min(1).max(160),
    args: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({ op: z.literal("mcp.status"), ...mcpTarget }),
  z.strictObject({ op: z.literal("mcp.stop"), ...mcpTarget }),
  z.strictObject({ op: z.literal("computer.environment"), homeKey: id }),
  z.strictObject({
    op: z.literal("computer.exec"),
    homeKey: id,
    argv: z.array(z.string().max(4096)).min(1).max(64),
    hostIntegration: HostIntegrationSchema.pick({ id: true, identity: true, workspace: true })
      .extend({ identity: z.string().min(1).max(240) })
      .optional(),
    cwd: path.optional(),
    timeoutMs: z.number().int().min(1).max(300_000).optional(),
  }),
  z.strictObject({
    op: z.literal("computer.files.read"),
    homeKey: id,
    path,
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(IDE_FILE_BYTES + 1)
      .optional(),
    editor: z.literal(true).optional(),
  }),
  z.strictObject({
    op: z.literal("computer.files.write"),
    homeKey: id,
    path,
    content: z
      .string()
      .max(Math.ceil(IDE_FILE_BYTES / 3) * 4)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    executable: z.boolean().optional(),
    editor: z.literal(true).optional(),
  }),
  z.strictObject({ op: z.literal("computer.files.list"), homeKey: id, path }),
  z.strictObject({
    op: z.literal("computer.lifecycle"),
    homeKey: id,
    action: z.enum(["create", "prepare", "sleep", "wake", "destroy", "cwd", "snapshot"]),
    cwd: path.optional(),
  }),
  z.strictObject({ op: z.literal("runtime.turn"), homeKey: id, request: HostTurnSchema }),
  z.strictObject({ op: z.literal("host.health") }),
]);
export type HostOperation = z.infer<typeof HostOperationSchema>;
export const HostRequestSchema = z.strictObject({
  v: z.literal(1),
  type: z.literal("request"),
  id,
  scope: HostScopeSchema,
  operation: HostOperationSchema,
});
export type HostRequest = z.infer<typeof HostRequestSchema>;
export const HostHealthSchema = z.strictObject({
  name: z.string().trim().min(1).max(80).optional(),
  platform: z.enum(["darwin", "linux", "win32"]),
  roots: z.array(path).max(32),
  load: z.number().int().min(0).max(HOST_IN_FLIGHT),
  claude: RuntimeAvailabilitySchema,
  codex: RuntimeAvailabilitySchema,
  environment: HostEnvironmentSchema.optional(),
  integrations: z.array(HostIntegrationSchema).max(16).optional(),
});
export type HostHealth = z.infer<typeof HostHealthSchema>;
export const HostStatusSchema = z.strictObject({
  roots: z.array(path).max(32).default([]),
  configured: z.boolean(),
  connected: z.boolean(),
  health: HostHealthSchema.nullable(),
});
export type HostStatus = z.infer<typeof HostStatusSchema>;
export const HostFrameSchema = z.discriminatedUnion("type", [
  HostRequestSchema,
  z.strictObject({ v: z.literal(1), type: z.literal("cancel"), id }),
  z.strictObject({
    v: z.literal(1),
    type: z.literal("ack"),
    id,
    seq: z.number().int().nonnegative(),
  }),
  z.strictObject({
    v: z.literal(1),
    type: z.literal("stream"),
    id,
    seq: z.number().int().nonnegative(),
    channel: z.enum(["stdout", "stderr", "exit", "event", "file", "result"]),
    data: z.unknown(),
  }),
  z.strictObject({
    v: z.literal(1),
    type: z.literal("end"),
    id,
    problem: RuntimeProblemSchema.optional(),
  }),
  z.strictObject({
    v: z.literal(1),
    type: z.literal("callback"),
    id,
    callId: id,
    method: z.enum([
      "authorizeTool",
      "executeTool",
      "onToolCompleted",
      "onRuntimeInfo",
      "claimSteering",
    ]),
    args: z.array(z.unknown()).max(5),
  }),
  z.strictObject({
    v: z.literal(1),
    type: z.literal("reply"),
    id,
    callId: id,
    value: z.unknown().optional(),
    failed: z.boolean().optional(),
  }),
  z.strictObject({ v: z.literal(1), type: z.literal("health"), health: HostHealthSchema }),
]);
export type HostFrame = z.infer<typeof HostFrameSchema>;
export function encodeHostFrame(frame: HostFrame) {
  const data = JSON.stringify(HostFrameSchema.parse(frame));
  if (new TextEncoder().encode(data).byteLength > frameLimit(frame))
    throw new Error("Host frame too large.");
  return data;
}
export function decodeHostFrame(data: string): HostFrame {
  const size = new TextEncoder().encode(data).byteLength;
  if (size > HOST_WRITE_FRAME_BYTES) throw new Error("Host frame too large.");
  const frame = HostFrameSchema.parse(JSON.parse(data));
  if (size > frameLimit(frame)) throw new Error("Host frame too large.");
  return frame;
}
function frameLimit(frame: HostFrame) {
  return frame.type === "request" &&
    frame.operation.op === "computer.files.write" &&
    frame.operation.editor
    ? HOST_WRITE_FRAME_BYTES
    : HOST_FRAME_BYTES;
}
export function hostSocketUrl(apiUrl: string, internal = false) {
  const url = new URL(apiUrl);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    !["http:", "https:", "ws:", "wss:"].includes(url.protocol) ||
    (!internal && !loopback && !["https:", "wss:"].includes(url.protocol))
  )
    throw new Error("Host connections require HTTPS outside loopback.");
  url.protocol = ["https:", "wss:"].includes(url.protocol) ? "wss:" : "ws:";
  url.pathname = internal ? "/api/host-bridge/worker" : "/api/host-bridge/socket";
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** Native adapters emit only this shared runtime event vocabulary. */
export const HostRuntimeEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text }),
  z.strictObject({ type: z.literal("progress"), text, activity: z.literal(true).optional() }),
  z.strictObject({
    type: z.literal("tool"),
    name: z.string().max(160),
    args: z.record(z.string(), z.unknown()),
    executionId: z.string().max(256),
  }),
  z.strictObject({
    type: z.literal("ask"),
    text,
    detail: text.optional(),
    actions: z
      .array(z.strictObject({ id: z.string(), label: z.string() }))
      .max(8)
      .optional(),
  }),
  z.strictObject({ type: z.literal("takeover"), reason: text }),
  z.strictObject({
    type: z.literal("usage"),
    delegationId: z.string().optional(),
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    cachedTokens: z.number().nonnegative().optional(),
    provider: z.string(),
    model: z.string(),
  }),
  z.strictObject({ type: z.literal("checkpoint"), blob: text }),
  z.strictObject({ type: z.literal("done"), text: text.optional() }),
]);
/** Canonical text for a public identifier; hashing it never yields a host credential. */
// Defined in plain JavaScript so the packaged desktop app can load it.
export { hostRegistrationIdentityText } from "./host-registration-identity.js";
