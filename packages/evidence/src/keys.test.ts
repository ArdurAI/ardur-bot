import { generateKeyPairSync, sign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  evidenceKeyId,
  generateEvidenceKey,
  loadEvidencePrivateKey,
  loadEvidencePublicKey,
} from "./keys.js";

const publicVector = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAERJkgvz6CLoHOYYYTFQ0mz/V1sW+E
4HS3c52eEuvyB5jU1t/KahlOQi7SkwHbjyBBeastn7eJiDulD+5NKjk3KA==
-----END PUBLIC KEY-----
`;

describe("evidence keys", () => {
  it("matches the independent key ID vector", () => {
    expect(evidenceKeyId(publicVector)).toBe(
      "sha256:739a9421b476751736ab76470ddfddbe03222b79fac2afe9d68c057843d1cf8e",
    );
    expect(evidenceKeyId(loadEvidencePublicKey(publicVector))).toBe(evidenceKeyId(publicVector));
  });
  it("generates loadable SPKI and PKCS#8 keys", () => {
    const keys = generateEvidenceKey();
    expect(keys.publicKeyPem).toContain("BEGIN PUBLIC KEY");
    expect(keys.privateKeyPem).toContain("BEGIN PRIVATE KEY");
    expect(keys.kid).toBe(evidenceKeyId(keys.publicKeyPem));
    const data = Buffer.from("test");
    const signature = sign("sha256", data, {
      key: loadEvidencePrivateKey(keys.privateKeyPem),
      dsaEncoding: "ieee-p1363",
    });
    expect(signature).toHaveLength(64);
    expect(
      verify(
        "sha256",
        data,
        { key: loadEvidencePublicKey(keys.publicKeyPem), dsaEncoding: "ieee-p1363" },
        signature,
      ),
    ).toBe(true);
  });
  it.each(["rsa", "secp384r1", "secp256k1"])("rejects %s keys", (kind) => {
    const keys =
      kind === "rsa"
        ? generateKeyPairSync("rsa", { modulusLength: 2048 })
        : generateKeyPairSync("ec", { namedCurve: kind });
    expect(() =>
      loadEvidencePrivateKey(keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString()),
    ).toThrow("EC P-256");
    expect(() =>
      loadEvidencePublicKey(keys.publicKey.export({ type: "spki", format: "pem" }).toString()),
    ).toThrow("EC P-256");
    expect(() => evidenceKeyId(keys.publicKey)).toThrow("EC P-256");
  });
  it("rejects malformed PEM and private KeyObjects as key IDs", () => {
    expect(() => loadEvidencePublicKey("invalid")).toThrow();
    expect(() => loadEvidencePrivateKey("invalid")).toThrow();
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    expect(() => evidenceKeyId(privateKey)).toThrow("public key");
  });
});
