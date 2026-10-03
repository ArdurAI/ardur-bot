import { createHash, generateKeyPairSync, sign, verify, X509Certificate } from "node:crypto";
import type { DeviceProof, PairingPayload } from "@ardurbot/contracts";
import { deviceSignedText, homeSignedText, pairingSignedText } from "@ardurbot/contracts";

export function createDeviceKeys() {
  const pair = () => {
    const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    return {
      publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    };
  };
  const request = pair();
  const presence = pair();
  // A separate presence public key is required by the protocol. The CLI never
  // asserts user presence or supports consequential approval.
  return { ...request, presencePublicKey: presence.publicKey };
}
export function signPairing(home: PairingPayload, keys: ReturnType<typeof createDeviceKeys>) {
  return signText(
    keys.privateKey,
    pairingSignedText(home.challenge, home.instanceId, keys.publicKey, keys.presencePublicKey),
  );
}
export function signText(privateKey: string, text: string) {
  return sign("sha256", Buffer.from(text), privateKey).toString("base64");
}
export function signRequest(
  home: Pick<PairingPayload, "instanceId"> & { grantId: string; privateKey: string },
  nonce: string,
  timestamp: number,
  operation: string,
  body: unknown,
): DeviceProof {
  const proof = { grantId: home.grantId, nonce, timestamp };
  return {
    ...proof,
    signature: signText(home.privateKey, deviceSignedText(home.instanceId, proof, operation, body)),
  };
}
export function certificateMatches(raw: Buffer, fingerprint: string, now = Date.now()) {
  try {
    const cert = new X509Certificate(raw);
    return (
      createHash("sha256").update(cert.raw).digest("hex") === fingerprint &&
      Date.parse(cert.validFrom) <= now &&
      now < Date.parse(cert.validTo)
    );
  } catch {
    return false;
  }
}
export function verifyHome(
  home: Pick<PairingPayload, "instanceId" | "fingerprint" | "certificateFingerprint">,
  challenge: string,
  identity: { instanceId: string; fingerprint: string; certificate: string; signature: string },
) {
  try {
    const cert = new X509Certificate(Buffer.from(identity.certificate, "base64"));
    return (
      identity.instanceId === home.instanceId &&
      identity.fingerprint === home.fingerprint &&
      certificateMatches(cert.raw, home.certificateFingerprint) &&
      createHash("sha256")
        .update(cert.publicKey.export({ type: "spki", format: "der" }))
        .digest("hex") === home.fingerprint &&
      verify(
        "sha256",
        Buffer.from(homeSignedText(home.instanceId, home.fingerprint, challenge)),
        cert.publicKey,
        Buffer.from(identity.signature, "base64"),
      )
    );
  } catch {
    return false;
  }
}
