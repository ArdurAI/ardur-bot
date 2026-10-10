import { readFileSync } from "node:fs";
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

const vectors: {
  instanceId: string;
  proof: { grantId: string; nonce: string; timestamp: number };
  requests: Array<{ operation: string; body: unknown; canonicalBody: string; signedText: string }>;
  rejected: Array<{ name: string; body: unknown; error: string }>;
} = JSON.parse(
  readFileSync(
    new URL("../../../apps/cli/fixtures/device-operations.json", import.meta.url),
    "utf8",
  ),
);
it.each(vectors.requests)("matches the signed operation vector $operation", (vector) => {
  expect(canonicalDispatchJson(vector.body)).toBe(vector.canonicalBody);
  expect(deviceSignedText(vectors.instanceId, vectors.proof, vector.operation, vector.body)).toBe(
    vector.signedText,
  );
});
it.each(vectors.rejected)("rejects $name instead of signing unrepresentable bytes", (vector) => {
  expect(() => canonicalDispatchJson(vector.body)).toThrow(vector.error);
});
it.each(["\ud800", "\udfff"])("rejects lone surrogate pairing values and keys", (unit) => {
  for (const field of ["challenge", "instanceId", "homeName"]) {
    const result = PairingPayloadSchema.safeParse({
      ...payload,
      [field]: payload[field as keyof typeof payload] + unit,
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(
        result.error.issues.some((issue) => issue.message.includes("well-formed Unicode")),
      ).toBe(true);
  }
  expect(
    PairingPayloadSchema.safeParse({ ...payload, hints: [`https://example.test/${unit}`] }).success,
  ).toBe(false);
  const key = PairingPayloadSchema.safeParse({ ...payload, [unit]: "value" });
  expect(key.success).toBe(false);
  if (!key.success) expect(key.error.issues[0]!.message).toContain("well-formed Unicode");
});
it("accepts paired surrogates and validates omitted object keys too", () => {
  expect(PairingPayloadSchema.parse({ ...payload, homeName: "Home 🚀" }).homeName).toBe("Home 🚀");
  expect(canonicalDispatchJson({ "🚀": "🚀" })).toBe('{"🚀":"🚀"}');
  expect(() => canonicalDispatchJson({ "\ud800": undefined })).toThrow("well-formed Unicode");
});

it("keeps the daily read vectors on the existing computer and board contracts", async () => {
  const { appContract } = await import("./rpc.js");
  const { boardContract } = await import("./board.js");
  for (const vector of vectors.requests.filter((row) => row.operation === "rpc")) {
    const body = vector.body as { procedure: string; input: unknown };
    if (body.procedure === "computer/list")
      expect(appContract.computer.list["~orpc"].outputSchema).toBeDefined();
    else if (body.procedure === "board/snapshot")
      expect(boardContract.snapshot["~orpc"].inputSchema!.safeParse(body.input).success).toBe(true);
    else if (body.procedure === "board/show")
      expect(boardContract.show["~orpc"].inputSchema!.safeParse(body.input).success).toBe(true);
    else throw new Error("Unexpected fixture procedure");
  }
});
it("validates every room request vector and retains multiple-run and receipt-only outputs", async () => {
  const {
    DeviceRoomsListInputSchema,
    DeviceRoomSendInputSchema,
    DeviceRoomSendOutputSchema,
    DeviceRoomsListOutputSchema,
  } = await import("./dispatch.js");
  const all = JSON.parse(
    readFileSync(
      new URL("../../../apps/cli/fixtures/device-operations.json", import.meta.url),
      "utf8",
    ),
  );
  for (const vector of all.requests) {
    if (vector.operation === "rooms/list")
      expect(DeviceRoomsListInputSchema.parse(vector.body)).toEqual({});
    if (vector.operation === "rooms/send")
      expect(DeviceRoomSendInputSchema.parse(vector.body)).toEqual(vector.body);
  }
  for (const vector of all.responses) {
    if (vector.operation === "rooms/list")
      expect(DeviceRoomsListOutputSchema.parse(vector.body)).toEqual(vector.body);
    if (vector.operation === "rooms/send")
      expect(DeviceRoomSendOutputSchema.parse(vector.body)).toEqual(vector.body);
  }
});
it("denies malformed room targets, unbounded text, invalid Unicode and impersonation fields", async () => {
  const { DeviceRoomSendInputSchema, DeviceRoomsListInputSchema } = await import("./dispatch.js");
  const base = { groupId: "room", clientNonce: "fixture-room-request", text: "hello" };
  for (const input of [
    { ...base, roomName: "Room" },
    { ...base, groupId: undefined },
    { ...base, text: " " },
    { ...base, text: "x".repeat(32001) },
    { ...base, text: "\ud800" },
    { ...base, clientNonce: "short" },
    { ...base, userId: "foreign" },
    { ...base, spaceId: "foreign" },
    { ...base, botId: "foreign" },
    { ...base, mentions: ["foreign"] },
  ])
    expect(DeviceRoomSendInputSchema.safeParse(input).success).toBe(false);
  expect(DeviceRoomsListInputSchema.safeParse({ userId: "foreign" }).success).toBe(false);
});

it("validates the daily read response fixtures against their unchanged output contracts", async () => {
  const { appContract } = await import("./rpc.js");
  const { BoardProblemSchema, boardContract } = await import("./board.js");
  const all = JSON.parse(
    readFileSync(
      new URL("../../../apps/cli/fixtures/device-operations.json", import.meta.url),
      "utf8",
    ),
  );
  for (const vector of all.responses.filter(
    (row: { operation: string }) => row.operation === "rpc",
  )) {
    if (vector.status === 403) {
      expect(BoardProblemSchema.parse(vector.body.problem)).toEqual(vector.body.problem);
      expect(vector.body.message).toBe(vector.body.problem.message);
    } else if (vector.procedure === "computer/list")
      expect(appContract.computer.list["~orpc"].outputSchema!.parse(vector.body)).toEqual(
        vector.body,
      );
    else if (vector.procedure === "board/snapshot")
      expect(boardContract.snapshot["~orpc"].outputSchema!.parse(vector.body)).toEqual(vector.body);
    else if (vector.procedure === "board/show")
      expect(boardContract.show["~orpc"].outputSchema!.parse(vector.body)).toEqual(vector.body);
    else throw new Error("Unexpected fixture procedure");
  }
});
