import type { KeyObject } from "node:crypto";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";

function requireP256(key: KeyObject): KeyObject {
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new TypeError("Evidence keys must be EC P-256");
  }
  return key;
}

export function loadEvidencePrivateKey(pem: string): KeyObject {
  return requireP256(createPrivateKey(pem));
}

export function loadEvidencePublicKey(pem: string): KeyObject {
  if (
    !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----$/.test(pem.trim())
  ) {
    throw new TypeError("Expected an SPKI public key PEM");
  }
  return requireP256(createPublicKey(pem));
}

export function evidenceKeyId(publicKey: KeyObject | string): string {
  const key = requireP256(
    typeof publicKey === "string" ? loadEvidencePublicKey(publicKey) : publicKey,
  );
  if (key.type !== "public") throw new TypeError("Expected a public key");
  return `sha256:${createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("hex")}`;
}

export function generateEvidenceKey(): {
  kid: string;
  publicKeyPem: string;
  privateKeyPem: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    kid: evidenceKeyId(publicKey),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}
