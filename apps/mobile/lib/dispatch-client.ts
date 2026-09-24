import type { DispatchInput, DispatchReceipt } from "@ardurbot/contracts";
import {
  canonicalDispatchJson,
  DispatchReceiptSchema,
  deviceSignedText,
  homeSignedText,
  PairingPayloadSchema,
  pairingSignedText,
} from "@ardurbot/contracts";

export interface DeviceKeys {
  handle: string;
  publicKey: string;
  presencePublicKey: string;
  publicKeyFingerprint: string;
}
export interface NativeDevices {
  nonce(): string;
  createKeys(): Promise<DeviceKeys>;
  sign(handle: string, text: string, presence: boolean): Promise<string>;
  verifyHome(
    certificate: string,
    fingerprint: string,
    text: string,
    signature: string,
  ): Promise<boolean>;
  request(
    url: string,
    fingerprint: string,
    body: string,
  ): Promise<{ status: number; body: string }>;
  scanQr(): Promise<string>;
}
export interface PairedHome {
  url: string;
  instanceId: string;
  fingerprint: string;
  certificateFingerprint: string;
  homeName: string;
  grantId: string;
  spaceId: string;
  keys: DeviceKeys;
}
export interface DeviceStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}
export const DEVICE_HOME_KEY = "ardurbot.device.home";
export const WAITING_FOR_HOME = "Waiting for home";
export const HOME_UNREACHABLE = "Home unreachable — check that Ardur Bot is running";
export const HOME_CHANGED = "This home's identity changed; pair your phone again.";
export function dispatchReceiptLabel(receipt: Pick<DispatchReceipt, "state" | "cancelRequested">) {
  if (receipt.cancelRequested && !["stopped", "done", "failed"].includes(receipt.state))
    return "Stopping";
  return {
    "waiting-for-home": WAITING_FOR_HOME,
    accepted: "Accepted",
    running: "Running",
    done: "Done",
    stopped: "Stopped",
    failed: "Failed",
  }[receipt.state];
}
export function createDispatchClient(
  native: NativeDevices,
  storage: DeviceStorage,
  status: (text: string | null) => void = () => undefined,
) {
  const loadHome = async (): Promise<PairedHome | null> => {
    const stored = await storage.get(DEVICE_HOME_KEY);
    return stored ? (JSON.parse(stored) as PairedHome) : null;
  };
  async function post<T>(
    home: Pick<PairedHome, "url" | "certificateFingerprint">,
    path: string,
    body: unknown,
  ): Promise<T> {
    let response: { status: number; body: string };
    try {
      response = await native.request(
        `${home.url}${path}`,
        home.certificateFingerprint,
        canonicalDispatchJson(body),
      );
    } catch (error) {
      throw new Error(
        error instanceof Error && error.message.includes("identity changed")
          ? HOME_CHANGED
          : HOME_UNREACHABLE,
      );
    }
    let parsed: T & { message?: string };
    try {
      parsed = JSON.parse(response.body);
    } catch {
      throw new Error(HOME_UNREACHABLE);
    }
    if (response.status < 200 || response.status >= 300)
      throw new Error(parsed.message ?? "This request could not finish; try again.");
    return parsed;
  }
  async function hello(
    home: Pick<PairedHome, "url" | "certificateFingerprint" | "instanceId" | "fingerprint">,
    grantId?: string,
    presence = false,
  ) {
    const clientChallenge = native.nonce();
    const proof = await post<{
      instanceId: string;
      fingerprint: string;
      certificate: string;
      signature: string;
      nonce: string;
      timestamp: number;
    }>(home, "/device/nonce", {
      clientChallenge,
      grantId,
      purpose: presence ? "presence" : "request",
    });
    if (
      proof.instanceId !== home.instanceId ||
      proof.fingerprint !== home.fingerprint ||
      !(await native.verifyHome(
        proof.certificate,
        home.certificateFingerprint,
        homeSignedText(home.instanceId, home.fingerprint, clientChallenge),
        proof.signature,
      ))
    )
      throw new Error(HOME_CHANGED);
    return proof;
  }
  async function request<T>(operation: string, body: unknown = {}): Promise<T> {
    const home = await loadHome();
    if (!home) throw new Error("Pair your phone with your home first.");
    try {
      const { nonce, timestamp } = await hello(home, home.grantId, operation === "presence");
      const proof = { grantId: home.grantId, nonce, timestamp };
      const signature = await native.sign(
        home.keys.handle,
        deviceSignedText(home.instanceId, proof, operation, body),
        operation === "presence",
      );
      return post<T>(home, "/device/request", { operation, body, proof: { ...proof, signature } });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === HOME_UNREACHABLE ||
          error.message === HOME_CHANGED ||
          error.message.startsWith("This device"))
      )
        status(error.message);
      throw error;
    }
  }
  async function pair(payloadInput: unknown, url: string, shortCode?: string) {
    const payload = PairingPayloadSchema.parse(payloadInput);
    const origin = new URL(url);
    if (
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.pathname !== "/"
    )
      throw new Error("Choose an HTTPS home.");
    const home = { url: origin.origin, ...payload };
    status(WAITING_FOR_HOME);
    await hello(home);
    const keys = await native.createKeys();
    const challenge = shortCode?.trim().toUpperCase() || payload.challenge;
    const signature = await native.sign(
      keys.handle,
      pairingSignedText(challenge, payload.instanceId, keys.publicKey, keys.presencePublicKey),
      false,
    );
    const result = await post<{ grantId?: string; spaceId?: string; pendingId?: string }>(
      home,
      shortCode ? "/device/code" : "/device/pair",
      {
        challenge,
        instanceId: payload.instanceId,
        deviceName: "Phone",
        devicePublicKey: keys.publicKey,
        presencePublicKey: keys.presencePublicKey,
        signature,
      },
    );
    const save = async (grant: { grantId: string; spaceId: string }) => {
      const paired: PairedHome = {
        url: home.url,
        homeName: payload.homeName,
        instanceId: home.instanceId,
        fingerprint: home.fingerprint,
        certificateFingerprint: home.certificateFingerprint,
        keys,
        ...grant,
      };
      await storage.set(DEVICE_HOME_KEY, JSON.stringify(paired));
      status(null);
      return paired;
    };
    if (result.grantId && result.spaceId)
      return { home: await save({ grantId: result.grantId, spaceId: result.spaceId }) };
    if (!result.pendingId) throw new Error("Pairing could not finish; try again at home.");
    const pendingId = result.pendingId;
    return {
      fingerprint: keys.publicKeyFingerprint,
      poll: async () => {
        await hello(home);
        const signature = await native.sign(
          keys.handle,
          pairingSignedText(pendingId, payload.instanceId, keys.publicKey, keys.presencePublicKey),
          false,
        );
        const grant = await post<{ grantId?: string; spaceId?: string }>(home, "/device/claim", {
          pendingId,
          signature,
        });
        return grant.grantId && grant.spaceId
          ? save({ grantId: grant.grantId, spaceId: grant.spaceId })
          : null;
      },
    };
  }
  async function send(input: Omit<DispatchInput, "clientNonce">): Promise<DispatchReceipt> {
    const home = await loadHome();
    if (!home) throw new Error("Pair your phone first.");
    const key = `ardurbot.dispatch.pending.${home.grantId}`;
    const stored = await storage.get(key);
    const pending = stored
      ? (JSON.parse(stored) as { input: DispatchInput; createdAt: number })
      : { input: { ...input, clientNonce: native.nonce() }, createdAt: Date.now() };
    const { clientNonce: _nonce, ...original } = pending.input;
    if (canonicalDispatchJson(original) !== canonicalDispatchJson(input))
      throw new Error("A task is waiting for home; retry or discard it first.");
    if (Date.now() - pending.createdAt > 24 * 60 * 60_000)
      throw new Error("This unsent task expired; discard it before sending again.");
    await storage.set(key, JSON.stringify(pending));
    status(WAITING_FOR_HOME);
    try {
      const receipt = DispatchReceiptSchema.parse(await request("dispatch", pending.input));
      await storage.remove(key);
      status(dispatchReceiptLabel(receipt));
      return receipt;
    } catch (error) {
      status(WAITING_FOR_HOME);
      throw error;
    }
  }
  async function pending() {
    const home = await loadHome();
    if (!home) return null;
    const stored = await storage.get(`ardurbot.dispatch.pending.${home.grantId}`);
    return stored
      ? (JSON.parse(stored) as { input: DispatchInput; createdAt: number }).input
      : null;
  }
  return {
    loadHome,
    request,
    pair,
    send,
    pending,
    hello,
    retry: async () => {
      const input = await pending();
      if (!input) return;
      const { clientNonce: _nonce, ...body } = input;
      return send(body);
    },
    discard: async () => {
      const home = await loadHome();
      if (home) await storage.remove(`ardurbot.dispatch.pending.${home.grantId}`);
      status(null);
    },
    unpair: () => storage.remove(DEVICE_HOME_KEY),
  };
}
