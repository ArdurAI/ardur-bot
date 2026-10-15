import { createHash, sign, X509Certificate } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deviceSignedText, homeSignedText, pairingSignedText } from "@ardurbot/contracts";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { verifyDeviceSignature } from "../../../packages/db/src/device-grants.js";
import { generateInstanceCertificate } from "../../api/src/instance-certificate.js";
import { createClient, decodePairingCode, pairDevice } from "./client.js";
import { configDirectory, loadHome, saveHome } from "./config.js";
import { createDeviceKeys, signPairing, signRequest, verifyHome } from "./crypto.js";
import type { Transport } from "./transport.js";

let material: Awaited<ReturnType<typeof generateInstanceCertificate>>;
beforeAll(async () => {
  material = await generateInstanceCertificate();
});
function fixture() {
  const cert = new X509Certificate(material.certificate);
  const payload = {
    version: 1 as const,
    challenge: "challenge".repeat(5),
    instanceId: "fixture-home",
    homeName: "Home",
    fingerprint: createHash("sha256")
      .update(cert.publicKey.export({ type: "spki", format: "der" }))
      .digest("hex"),
    certificateFingerprint: createHash("sha256").update(cert.raw).digest("hex"),
    hints: ["https://home.example.test"],
  };
  const identity = (challenge: string) => ({
    instanceId: payload.instanceId,
    fingerprint: payload.fingerprint,
    certificate: cert.raw.toString("base64"),
    signature: sign(
      "sha256",
      Buffer.from(homeSignedText(payload.instanceId, payload.fingerprint, challenge)),
      material.privateKey,
    ).toString("base64"),
    nonce: "n".repeat(43),
    timestamp: Date.now(),
  });
  const post = vi.fn<Transport>(async (url, _pin, body) => {
    if (url.endsWith("/nonce"))
      return identity((body as { clientChallenge: string }).clientChallenge);
    if (url.endsWith("/pair")) {
      const input = body as {
        devicePublicKey: string;
        presencePublicKey: string;
        signature: string;
      };
      expect(
        verifyDeviceSignature(
          input.devicePublicKey,
          pairingSignedText(
            payload.challenge,
            payload.instanceId,
            input.devicePublicKey,
            input.presencePublicKey,
          ),
          input.signature,
        ),
      ).toBe(true);
      expect(input.devicePublicKey).not.toBe(input.presencePublicKey);
      expect(body).toMatchObject({ platform: "cli" });
      return { grantId: "fixture-grant", spaceId: "fixture-space", instanceId: payload.instanceId };
    }
    return { ok: true };
  });
  return { payload, post, identity };
}
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
describe("paired CLI", () => {
  it("signs the existing pairing and request texts accepted by the real verifier", () => {
    const { payload } = fixture();
    const keys = createDeviceKeys();
    expect(
      verifyDeviceSignature(
        keys.publicKey,
        pairingSignedText(
          payload.challenge,
          payload.instanceId,
          keys.publicKey,
          keys.presencePublicKey,
        ),
        signPairing(payload, keys),
      ),
    ).toBe(true);
    const home = { ...payload, grantId: "grant", privateKey: keys.privateKey };
    const body = { text: "Review", clientNonce: "c".repeat(32) };
    const proof = signRequest(home, "n".repeat(43), Date.now(), "dispatch", body);
    expect(
      verifyDeviceSignature(
        keys.publicKey,
        deviceSignedText(home.instanceId, proof, "dispatch", body),
        proof.signature,
      ),
    ).toBe(true);
    expect(
      verifyDeviceSignature(
        keys.publicKey,
        deviceSignedText(home.instanceId, proof, "stop", body),
        proof.signature,
      ),
    ).toBe(false);
  });
  it("pairs as cli without disclosing the private key", async () => {
    const f = fixture();
    const home = await pairDevice(JSON.stringify(f.payload), f.post);
    expect(home.grantId).toBe("fixture-grant");
    expect(JSON.stringify(f.post.mock.calls)).not.toContain(home.privateKey);
    const client = createClient(home, f.post);
    await client.request("rpc", { procedure: "bots/list", input: {} });
    expect(f.post.mock.calls.at(-1)?.[2]).toMatchObject({
      operation: "rpc",
      proof: { grantId: home.grantId },
    });
  });
  it.each(["instanceId", "fingerprint", "certificate", "signature"])(
    "fails closed on changed home %s before pairing or sending",
    async (field) => {
      const f = fixture();
      const post: Transport = async (_url, _pin, body) => ({
        ...f.identity((body as { clientChallenge: string }).clientChallenge),
        [field]: "changed",
      });
      await expect(pairDevice(JSON.stringify(f.payload), post)).rejects.toMatchObject({
        exitCode: 2,
      });
      const keys = createDeviceKeys();
      await expect(
        createClient(
          {
            ...f.payload,
            url: f.payload.hints[0]!,
            grantId: "grant",
            spaceId: "space",
            privateKey: keys.privateKey,
          },
          post,
        ).request("dispatch", { text: "Secret task" }),
      ).rejects.toMatchObject({ exitCode: 2 });
      expect(verifyHome(f.payload, "other-challenge", f.identity("challenge"))).toBe(false);
    },
  );
  it("accepts raw QR JSON and an encoded copy, rejects malformed payloads", () => {
    const f = fixture();
    expect(decodePairingCode(JSON.stringify(f.payload))).toEqual(f.payload);
    expect(decodePairingCode(Buffer.from(JSON.stringify(f.payload)).toString("base64url"))).toEqual(
      f.payload,
    );
    expect(() => decodePairingCode("not a code")).toThrow("Copy a new pairing code");
    expect(() =>
      decodePairingCode(JSON.stringify({ ...f.payload, hints: ["http://home.example.test"] })),
    ).toThrow();
  });
  it("stores and reads a private 0600 config with a 0700 directory", async () => {
    const f = fixture();
    const directory = await mkdtemp(path.join(tmpdir(), "ardur-cli-"));
    directories.push(directory);
    const home = await pairDevice(JSON.stringify(f.payload), f.post);
    await saveHome(home, directory);
    const file = path.join(directory, "home.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect(await loadHome(directory)).toEqual(home);
    expect(JSON.parse(await readFile(file, "utf8")).grantId).toBe(home.grantId);
    if (process.platform !== "win32") {
      await chmod(file, 0o644);
      await expect(loadHome(directory)).rejects.toMatchObject({ exitCode: 2 });
    }
  });
  it("refuses symlink config files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ardur-cli-"));
    directories.push(directory);
    await symlink("missing.json", path.join(directory, "home.json"));
    await expect(loadHome(directory)).rejects.toMatchObject({ exitCode: 2 });
  });
  it("uses the native config paths without a provider-specific setting", () => {
    expect(configDirectory("linux", { XDG_CONFIG_HOME: "/config" }, "/home")).toBe("/config/ardur");
    expect(configDirectory("darwin", {}, "/home")).toBe("/home/Library/Application Support/ardur");
    expect(configDirectory("win32", { APPDATA: "/profile" }, "/home")).toBe("/profile/ardur");
  });
});

it("carries the test deadline to the nonce request and refuses a send after abort", async () => {
  const { payload, identity } = fixture();
  const controller = new AbortController();
  const post = vi.fn<Transport>(async (_url, _pin, body, signal) => {
    expect(signal).toBe(controller.signal);
    controller.abort();
    return identity((body as { clientChallenge: string }).clientChallenge);
  });
  const home = {
    ...payload,
    url: payload.hints[0]!,
    grantId: "grant",
    spaceId: "space",
    privateKey: createDeviceKeys().privateKey,
  };
  await expect(createClient(home, post, controller.signal).request("dispatch", {})).rejects.toThrow(
    "Waiting stopped.",
  );
  expect(post).toHaveBeenCalledOnce();
});
