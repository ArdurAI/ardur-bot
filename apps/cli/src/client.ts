import { randomBytes } from "node:crypto";
import type { PairingPayload } from "@ardurbot/contracts";
import { PairingPayloadSchema } from "@ardurbot/contracts";
import type { PairedHome } from "./config.js";
import { createDeviceKeys, signPairing, signRequest, verifyHome } from "./crypto.js";
import type { Transport } from "./transport.js";
import { CliError, HOME_CHANGED, pinnedPost } from "./transport.js";

export const nonce = () => randomBytes(32).toString("base64url");
export function decodePairingCode(code: string): PairingPayload {
  try {
    if (code.length > 16_384) throw new Error("Too long");
    return PairingPayloadSchema.parse(
      JSON.parse(
        code.trim().startsWith("{") ? code : Buffer.from(code, "base64url").toString("utf8"),
      ),
    );
  } catch {
    throw new CliError("Copy a new pairing code from Settings, Devices.", 3);
  }
}
async function hello(home: PairingPayload & { url: string }, post: Transport, grantId?: string) {
  const clientChallenge = nonce();
  const identity = (await post(`${home.url}/device/nonce`, home.certificateFingerprint, {
    clientChallenge,
    grantId,
    purpose: "request",
  })) as {
    instanceId: string;
    fingerprint: string;
    certificate: string;
    signature: string;
    nonce?: string;
    timestamp?: number;
  };
  if (!identity || !verifyHome(home, clientChallenge, identity))
    throw new CliError(HOME_CHANGED, 2);
  return identity;
}
export async function pairDevice(code: string, post: Transport = pinnedPost): Promise<PairedHome> {
  const payload = decodePairingCode(code);
  const hint = payload.hints[0];
  if (!hint || new URL(hint).origin !== hint)
    throw new CliError("Start pairing with an HTTPS home address in Settings, Devices.", 3);
  const home = { ...payload, url: hint };
  await hello(home, post);
  const keys = createDeviceKeys();
  const result = (await post(`${home.url}/device/pair`, home.certificateFingerprint, {
    challenge: payload.challenge,
    instanceId: payload.instanceId,
    deviceName: "Command line",
    platform: "cli",
    devicePublicKey: keys.publicKey,
    presencePublicKey: keys.presencePublicKey,
    signature: signPairing(payload, keys),
  })) as { grantId?: string; spaceId?: string; instanceId?: string };
  if (
    !result ||
    typeof result.grantId !== "string" ||
    !result.grantId ||
    typeof result.spaceId !== "string" ||
    !result.spaceId ||
    result.instanceId !== home.instanceId
  )
    throw new CliError("Pairing could not finish; try again at home.");
  return { ...home, grantId: result.grantId, spaceId: result.spaceId, privateKey: keys.privateKey };
}
export function createClient(home: PairedHome, post: Transport = pinnedPost) {
  return {
    async request<T>(operation: string, body: unknown = {}): Promise<T> {
      const identity = await hello(home, post, home.grantId);
      if (
        typeof identity.nonce !== "string" ||
        identity.nonce.length < 32 ||
        identity.nonce.length > 128 ||
        !Number.isSafeInteger(identity.timestamp) ||
        identity.timestamp! <= 0 ||
        Math.abs(Date.now() - identity.timestamp!) > 60_000
      )
        throw new CliError("Home returned an expired request; try again.");
      const proof = signRequest(home, identity.nonce, identity.timestamp!, operation, body);
      return (await post(`${home.url}/device/request`, home.certificateFingerprint, {
        operation,
        body,
        proof,
      })) as T;
    },
  };
}
