import {
  createHash,
  createPrivateKey,
  randomBytes,
  sign,
  verify,
  X509Certificate,
} from "node:crypto";
import { EncryptedSecretStore } from "@ardurbot/adapters";
import type { PrismaClient } from "@ardurbot/db";
import { expect, it, vi } from "vitest";
import { ensureInstanceIdentity } from "./instance-identity.js";

it("persists a verifiable home certificate with only an encrypted private key", async () => {
  let saved: Awaited<ReturnType<typeof ensureInstanceIdentity>> | null = null;
  const prisma = {
    instanceIdentity: {
      findUnique: vi.fn(async () => saved),
      upsert: vi.fn(async ({ create }) => {
        saved ??= create;
        return saved;
      }),
    },
  } as unknown as PrismaClient;
  const secrets = new EncryptedSecretStore(randomBytes(32).toString("base64"));
  const home = await ensureInstanceIdentity(prisma, secrets);
  const certificate = new X509Certificate(home.certificate);
  expect(certificate.verify(certificate.publicKey)).toBe(true);
  expect(createHash("sha256").update(certificate.raw).digest("hex")).toBe(
    home.certificateFingerprint,
  );
  expect(home.privateKeyCiphertext.startsWith("v2:")).toBe(true);
  expect(JSON.stringify(home)).not.toContain("PRIVATE KEY");
  const key = createPrivateKey(secrets.load(home.privateKeyCiphertext, home.instanceId));
  expect(
    verify(
      "sha256",
      Buffer.from("proof"),
      home.publicKey,
      sign("sha256", Buffer.from("proof"), key),
    ),
  ).toBe(true);
  expect(await ensureInstanceIdentity(prisma, secrets)).toEqual(home);
  expect(prisma.instanceIdentity.upsert).toHaveBeenCalledOnce();
});
