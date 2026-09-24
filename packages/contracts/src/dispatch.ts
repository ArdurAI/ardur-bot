import { oc } from "@orpc/contract";
import * as z from "zod";

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
export const PairingPayloadSchema = z.strictObject({
  version: z.literal(1),
  challenge: z.string().min(32).max(128),
  instanceId: z.string().min(1).max(128),
  homeName: z.string().min(1).max(80),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  certificateFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  hints: z
    .array(
      z.url().refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
        );
      }),
    )
    .max(8),
});
export type PairingPayload = z.infer<typeof PairingPayloadSchema>;
export const DispatchInputSchema = z.strictObject({
  clientNonce: z.string().min(16).max(128),
  botId: z.string().min(1).max(128).optional(),
  text: z
    .string()
    .min(1)
    .max(32_000)
    .refine((text) => text.trim().length > 0),
  replyToTaskId: z.string().min(1).max(128).optional(),
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
export const DEVICE_API_PATHS = [
  "/device/pair",
  "/device/code",
  "/device/claim",
  "/device/nonce",
  "/device/request",
] as const;
export function isDeviceApiPath(path: string): boolean {
  return (DEVICE_API_PATHS as readonly string[]).includes(path);
}

/** Stable JSON is shared by the signer and verifier; signatures cover the operation and body. */
export function canonicalDispatchJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalDispatchJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonicalDispatchJson(v)}`)
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

export const devicesContract = {
  list: oc.output(
    z.object({
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
