import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EncryptedSecretStore } from "./secret-store.js";

describe("EncryptedSecretStore digest", () => {
  it("keys a digest to the deployment, so a reader without its key cannot confirm a guess", () => {
    const value = '{"command":"echo example-secret"}';
    const one = new EncryptedSecretStore("deployment-one-encryption-key");
    const two = new EncryptedSecretStore("deployment-two-encryption-key");
    const digest = one.digest("tool-call-arguments", value);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(one.digest("tool-call-arguments", value)).toBe(digest);
    expect(two.digest("tool-call-arguments", value)).not.toBe(digest);
    expect(one.digest("another-purpose", value)).not.toBe(digest);
    expect(createHash("sha256").update(value).digest("hex")).not.toBe(digest);
  });
});
