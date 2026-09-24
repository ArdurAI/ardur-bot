import { createHash, createPublicKey, randomUUID, X509Certificate } from "node:crypto";
import type { EncryptedSecretStore } from "@ardurbot/adapters";
import { ALL_DEVICE_SCOPES } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { generateInstanceCertificate } from "./instance-certificate.js";

export async function ensureInstanceIdentity(prisma: PrismaClient, secrets: EncryptedSecretStore) {
  const existing = await prisma.instanceIdentity.findUnique({ where: { id: "home" } });
  if (existing) return existing;
  const material = await generateInstanceCertificate();
  const instanceId = randomUUID();
  const encrypted = await secrets.put(
    material.privateKey,
    {
      operationId: "instance-identity",
      traceId: "instance-identity",
      spaceId: instanceId,
      userId: instanceId,
      signal: new AbortController().signal,
    },
    instanceId,
  );
  return prisma.instanceIdentity.upsert({
    where: { id: "home" },
    update: {},
    create: {
      id: "home",
      instanceId,
      homeName: "Ardur Bot",
      publicKey: material.publicKey,
      certificate: material.certificate,
      privateKeyCiphertext: encrypted.ciphertext,
      scopes: [...ALL_DEVICE_SCOPES],
      fingerprint: createHash("sha256")
        .update(createPublicKey(material.publicKey).export({ type: "spki", format: "der" }))
        .digest("hex"),
      certificateFingerprint: createHash("sha256")
        .update(new X509Certificate(material.certificate).raw)
        .digest("hex"),
    },
  });
}
