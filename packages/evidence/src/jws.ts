import type { KeyObject } from "node:crypto";
import { createHash, createPublicKey, sign, verify } from "node:crypto";
import { BASE64URL_PATTERN, EvidenceFormatError } from "./errors.js";
import { canonicalize } from "./jcs.js";
import { evidenceKeyId, loadEvidencePrivateKey, loadEvidencePublicKey } from "./keys.js";

export const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export function signCompact(
  claims: unknown,
  privateKey: KeyObject | string,
  kid: string,
  typ: string,
): string {
  const key = typeof privateKey === "string" ? loadEvidencePrivateKey(privateKey) : privateKey;
  if (
    key.type !== "private" ||
    key.asymmetricKeyType !== "ec" ||
    key.asymmetricKeyDetails?.namedCurve !== "prime256v1" ||
    evidenceKeyId(createPublicKey(key)) !== kid
  ) {
    throw new EvidenceFormatError("invalid_key", "kid", "Expected matching EC P-256 private key");
  }
  const header = Buffer.from(canonicalize({ alg: "ES256", kid, typ })).toString("base64url");
  const payload = Buffer.from(canonicalize(claims)).toString("base64url");
  const data = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(data, "ascii"), { key, dsaEncoding: "ieee-p1363" });
  return `${data}.${signature.toString("base64url")}`;
}

export function decodeCompact(jws: unknown): {
  header: unknown;
  payload: unknown;
  payloadBytes: Buffer;
  signature: Buffer;
  data: string;
} {
  if (typeof jws !== "string")
    throw new EvidenceFormatError("invalid_jws", "jws", "Expected a compact JWS");
  const parts = jws.split(".");
  if (
    parts.length !== 3 ||
    parts.some(
      (part) =>
        !BASE64URL_PATTERN.test(part) ||
        Buffer.from(part, "base64url").toString("base64url") !== part,
    )
  ) {
    throw new EvidenceFormatError("invalid_jws", "jws", "Expected three unpadded base64url parts");
  }
  const [header, payload, signature] = parts as [string, string, string];
  const payloadBytes = Buffer.from(payload, "base64url");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return {
    header: JSON.parse(decoder.decode(Buffer.from(header, "base64url"))),
    payload: JSON.parse(decoder.decode(payloadBytes)),
    payloadBytes,
    signature: Buffer.from(signature, "base64url"),
    data: `${header}.${payload}`,
  };
}

export function verifyCompactSignature(
  decoded: ReturnType<typeof decodeCompact>,
  publicKey: KeyObject | string,
): boolean {
  const key = typeof publicKey === "string" ? loadEvidencePublicKey(publicKey) : publicKey;
  evidenceKeyId(key);
  return (
    decoded.signature.length === 64 &&
    verify(
      "sha256",
      Buffer.from(decoded.data, "ascii"),
      { key, dsaEncoding: "ieee-p1363" },
      decoded.signature,
    )
  );
}
