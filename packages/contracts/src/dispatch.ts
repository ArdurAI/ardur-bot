import { oc } from "@orpc/contract";
import * as z from "zod";
import { ThreadSendResultSchema } from "./chief-loop.js";
import { GroupSchema } from "./domain.js";
import { FailureCategoryIdSchema } from "./failure-categories.js";
import { RunStatus } from "./ids.js";

export const UNICODE_MESSAGE = "Use well-formed Unicode strings.";
export function wellFormedUnicode(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
const deviceString = () => z.string().refine(wellFormedUnicode, UNICODE_MESSAGE);

export const DeviceScopeSchema = z.enum([
  "read",
  "dispatch",
  "steer",
  "stop",
  "approve",
  "ordinary",
  "consequential",
  "delegate",
]);
export type DeviceScope = z.infer<typeof DeviceScopeSchema>;
export const DEFAULT_DEVICE_SCOPES: DeviceScope[] = [
  "read",
  "dispatch",
  "steer",
  "stop",
  "approve",
  "ordinary",
];
export const ALL_DEVICE_SCOPES = DeviceScopeSchema.options;
export const PairingPayloadSchema = z.strictObject(
  {
    version: z.literal(1),
    challenge: deviceString().min(32).max(128),
    instanceId: deviceString().min(1).max(128),
    homeName: deviceString().min(1).max(80),
    fingerprint: deviceString().regex(/^[a-f0-9]{64}$/),
    certificateFingerprint: deviceString().regex(/^[a-f0-9]{64}$/),
    hints: z
      .array(
        z
          .url()
          .refine(wellFormedUnicode, UNICODE_MESSAGE)
          .refine((value) => {
            const url = new URL(value);
            return (
              url.protocol === "https:" &&
              !url.username &&
              !url.password &&
              !url.search &&
              !url.hash
            );
          }),
      )
      .max(8),
  },
  { error: "This pairing payload is incomplete; use well-formed Unicode strings." },
);
export type PairingPayload = z.infer<typeof PairingPayloadSchema>;
export const DispatchInputSchema = z.strictObject({
  clientNonce: deviceString().min(16).max(128),
  botId: deviceString().min(1).max(128).optional(),
  text: deviceString()
    .min(1)
    .max(32_000)
    .refine((text) => text.trim().length > 0),
  replyToTaskId: deviceString().min(1).max(128).optional(),
});
export type DispatchInput = z.infer<typeof DispatchInputSchema>;
export const DispatchStateSchema = z.enum([
  "waiting-for-home",
  "accepted",
  "running",
  "done",
  "stopped",
  "failed",
]);
export type DispatchState = z.infer<typeof DispatchStateSchema>;
export const DispatchReceiptSchema = z.object({
  taskId: z.string(),
  runId: z.string(),
  threadId: z.string(),
  botId: z.string(),
  state: DispatchStateSchema,
  cancelRequested: z.boolean(),
});
export type DispatchReceipt = z.infer<typeof DispatchReceiptSchema>;
export const DeviceGrantViewSchema = z.object({
  platform: z.string().nullable().optional(),
  kind: z.enum(["device", "channel"]).optional(),
  id: z.string(),
  deviceName: z.string(),
  scopes: z.array(DeviceScopeSchema),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  lastPresenceAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  defaultBotId: z.string().nullable(),
});
export type DeviceGrantView = z.infer<typeof DeviceGrantViewSchema>;
export const DeviceProofSchema = z.strictObject({
  grantId: z.string().min(1).max(128),
  nonce: z.string().min(32).max(128),
  timestamp: z.number().int().positive(),
  signature: z.string().min(1).max(256),
});
export type DeviceProof = z.infer<typeof DeviceProofSchema>;
// Defined in plain JavaScript so the packaged desktop app can load it (see device-paths.js).
export { DEVICE_API_PATHS, isDeviceApiPath } from "./device-paths.js";

/** Stable JSON is shared by the signer and verifier; signatures cover the operation and body. */
export function canonicalDispatchJson(value: unknown): string {
  if (typeof value === "string" && !wellFormedUnicode(value)) throw new TypeError(UNICODE_MESSAGE);
  if (Array.isArray(value)) return `[${value.map(canonicalDispatchJson).join(",")}]`;
  if (value && typeof value === "object") {
    if (Object.keys(value).some((key) => !wellFormedUnicode(key)))
      throw new TypeError(UNICODE_MESSAGE);
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, v]) => `${canonicalDispatchJson(key)}:${canonicalDispatchJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
export function pairingSignedText(
  challenge: string,
  instanceId: string,
  publicKey: string,
  presencePublicKey: string,
): string {
  return canonicalDispatchJson([
    "ardur-pair-v1",
    instanceId,
    challenge,
    publicKey,
    presencePublicKey,
  ]);
}
export function deviceSignedText(
  instanceId: string,
  proof: Pick<DeviceProof, "grantId" | "nonce" | "timestamp">,
  operation: string,
  body: unknown,
): string {
  return canonicalDispatchJson([
    "ardur-device-v1",
    instanceId,
    proof.grantId,
    proof.nonce,
    proof.timestamp,
    operation,
    body,
  ]);
}

export const DeviceListenerStateSchema = z.object({
  enabled: z.boolean(),
  hints: PairingPayloadSchema.shape.hints,
});
export type DeviceListenerState = z.infer<typeof DeviceListenerStateSchema>;

export const devicesContract = {
  list: oc.output(
    z.object({
      listener: DeviceListenerStateSchema,
      instanceId: z.string(),
      homeName: z.string(),
      fingerprint: z.string(),
      devices: z.array(DeviceGrantViewSchema),
      pending: z.array(
        z.object({ id: z.string(), deviceName: z.string(), publicKeyFingerprint: z.string() }),
      ),
    }),
  ),
  rename: oc
    .input(z.object({ id: z.string(), deviceName: z.string().trim().min(1).max(80) }))
    .output(z.object({ ok: z.literal(true) })),
  revoke: oc.input(z.object({ id: z.string() })).output(z.object({ ok: z.literal(true) })),
};
export const pairingContract = {
  start: oc
    .input(
      z.object({
        scopes: z.array(DeviceScopeSchema).default(DEFAULT_DEVICE_SCOPES),
        hints: PairingPayloadSchema.shape.hints.default([]),
      }),
    )
    .output(
      z.object({ payload: PairingPayloadSchema, shortCode: z.string(), expiresAt: z.string() }),
    ),
  confirm: oc
    .input(z.object({ id: z.string(), allow: z.boolean() }))
    .output(z.object({ ok: z.literal(true) })),
};

export function homeSignedText(instanceId: string, fingerprint: string, challenge: string): string {
  return canonicalDispatchJson(["ardur-home-v1", instanceId, fingerprint, challenge]);
}

// Signed device operations are separate from the existing session RPC list shapes.
const deviceId = deviceString().min(1).max(128);
export const DeviceRoomsListInputSchema = z.strictObject({});
export const DeviceRoomsListOutputSchema = z.array(GroupSchema);
export const DeviceRoomSendOutputSchema = ThreadSendResultSchema;
export const DeviceRoomSendInputSchema = z
  .strictObject({
    groupId: deviceId.optional(),
    roomName: deviceString().min(1).max(128).optional(),
    threadId: deviceId.optional(),
    clientNonce: deviceString().min(16).max(128),
    text: deviceString()
      .min(1)
      .max(32_000)
      .refine((text) => text.trim().length > 0),
  })
  .refine((value) => Boolean(value.groupId) !== Boolean(value.roomName), "Choose one room.");
export type DeviceRoomSendInput = z.infer<typeof DeviceRoomSendInputSchema>;
export const DeviceRunGetInputSchema = z.strictObject({ runId: deviceId });
export const DeviceTaskGetInputSchema = z.strictObject({ taskId: deviceId });
export const DeviceRunsListInputSchema = z.strictObject({
  cursor: deviceId.optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
export const DeviceMessagesGetInputSchema = z
  .strictObject({
    threadId: deviceId,
    botId: deviceId.optional(),
    groupId: deviceId.optional(),
    before: z.number().int().nonnegative().optional(),
    around: z.strictObject({ messageId: deviceId }).optional(),
  })
  .refine((value) => Boolean(value.botId) !== Boolean(value.groupId), "Choose one bot or room.");
export const DeviceRunDetailSchema = DispatchReceiptSchema.extend({
  status: RunStatus,
  cancelConfirmed: z.boolean(),
  messageId: z.string().nullable(),
  failure: z
    .object({
      category: FailureCategoryIdSchema,
      message: z.string(),
    })
    .nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});
export type DeviceRunDetail = z.infer<typeof DeviceRunDetailSchema>;
export const DeviceRunGetOutputSchema = z.object({ run: DeviceRunDetailSchema });
export const DeviceTaskGetOutputSchema = z.object({ task: DeviceRunDetailSchema });
export const DeviceRunsListOutputSchema = z.object({
  runs: z.array(DeviceRunDetailSchema).max(100),
  nextCursor: z.string().nullable(),
});
// Minimal reply-correlation projection; the wire response retains the existing ThreadMessagePage.
export const DeviceMessagesGetOutputSchema = z.object({
  threadId: z.string(),
  messages: z
    .array(
      z.object({
        id: z.string(),
        runId: z.string().nullable().optional(),
        role: z.string(),
        blocks: z.array(
          z.object({
            kind: z.string(),
            text: z.string().optional(),
            reasoning: z.boolean().optional(),
          }),
        ),
      }),
    )
    .max(100),
});

export const DeviceStopOutputSchema = z.object({ cancelRequested: z.literal(true) });
