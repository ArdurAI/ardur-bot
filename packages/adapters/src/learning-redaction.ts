import type { PrismaClient } from "@ardurbot/db";
import type { EncryptedSecretStore } from "./secrets.js";

/** Decrypt only inside the review boundary; these values never leave the redactor. */
export async function learningSecrets(
  prisma: PrismaClient,
  store: EncryptedSecretStore,
  scope: { spaceId: string; userId: string; botId: string },
): Promise<string[]> {
  const [secrets, botSecrets] = await Promise.all([
    prisma.secret.findMany({
      where: { OR: [{ spaceId: scope.spaceId }, { userId: scope.userId, spaceId: null }] },
      select: { id: true, ciphertext: true },
    }),
    prisma.botSecret.findMany({
      where: { spaceId: scope.spaceId, userId: scope.userId, botId: scope.botId },
      select: { id: true, ciphertext: true },
    }),
  ]);
  const values = new Set<string>();
  function collect(value: unknown) {
    if (typeof value === "string" && value.length >= 4) values.add(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  }
  for (const secret of [...secrets, ...botSecrets]) {
    const plaintext = store.load(secret.ciphertext, secret.id);
    values.add(plaintext);
    try {
      collect(JSON.parse(plaintext));
    } catch {
      /* Plain credentials need no decoding. */
    }
  }
  return [...values].filter(Boolean);
}
