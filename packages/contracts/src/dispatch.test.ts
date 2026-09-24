import { describe, expect, it } from "vitest";
import {
  canonicalDispatchJson,
  DispatchInputSchema,
  deviceSignedText,
  isDeviceApiPath,
  PairingPayloadSchema,
} from "./dispatch.js";

const payload = {
  version: 1,
  challenge: "x".repeat(43),
  instanceId: "test-home",
  homeName: "Test home",
  fingerprint: "a".repeat(64),
  certificateFingerprint: "b".repeat(64),
  hints: ["https://192.168.1.2:43119"],
};
describe("device wire contracts", () => {
  it("never admits session or connector credentials in a QR payload", () => {
    expect(PairingPayloadSchema.parse(payload)).toEqual(payload);
    for (const field of ["session", "token", "connectorCredential", "privateKey"])
      expect(PairingPayloadSchema.safeParse({ ...payload, [field]: "synthetic" }).success).toBe(
        false,
      );
    for (const url of [
      "http://home.test",
      "https://user:fake@home.test",
      "https://home.test?token=fake",
    ])
      expect(PairingPayloadSchema.safeParse({ ...payload, hints: [url] }).success).toBe(false);
  });
  it("canonicalizes object keys and binds operation, instance, nonce, timestamp and body", () => {
    expect(canonicalDispatchJson({ b: 1, a: { z: 2, y: null } })).toBe(
      canonicalDispatchJson({ a: { y: null, z: 2 }, b: 1 }),
    );
    const proof = { grantId: "phone", nonce: "nonce", timestamp: 123 };
    const original = deviceSignedText("home", proof, "dispatch", { a: 1 });
    expect(deviceSignedText("other", proof, "dispatch", { a: 1 })).not.toBe(original);
    expect(deviceSignedText("home", proof, "presence", { a: 1 })).not.toBe(original);
    expect(deviceSignedText("home", proof, "dispatch", { a: 2 })).not.toBe(original);
  });
  it.each([
    "/rpc/me",
    "/api/auth",
    "/local/device-listener",
    "/device/request?path=/rpc/me",
    "/device/../rpc/me",
    "/device/%72equest",
  ])("does not expose %s", (path) => expect(isDeviceApiPath(path)).toBe(false));
});

it("preserves the exact body for retry fingerprints", () => {
  const input = { clientNonce: "client-nonce-1234", text: " Task " };
  expect(DispatchInputSchema.parse(input)).toEqual(input);
  expect(DispatchInputSchema.safeParse({ ...input, text: "   " }).success).toBe(false);
});
