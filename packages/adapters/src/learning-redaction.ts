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
  function collect(value: unknown, credential = false) {
    if (typeof value === "string") {
      if (credential && value.length >= 8) values.add(value);
    } else if (Array.isArray(value)) {
      for (const item of value) collect(item, credential);
    } else if (value && typeof value === "object") {
      for (const [key, nested] of Object.entries(value)) {
        if (
          /^(?:name|label|displayName|description|kind|provider|type|baseUrl|url|endpoint|modelId)$/iu.test(
            key,
          )
        )
          continue;
        collect(
          nested,
          credential ||
            /(?:token|secret|password|passwd|api[_-]?key|private[_-]?key|authorization|cookie|credential)/iu.test(
              key,
            ),
        );
      }
    }
  }
  for (const secret of [...secrets, ...botSecrets]) {
    const plaintext = store.load(secret.ciphertext, secret.id);
    try {
      const parsed: unknown = JSON.parse(plaintext);
      if (typeof parsed === "string" || Array.isArray(parsed)) collect(parsed, true);
      else if (parsed === null || typeof parsed !== "object") {
        if (plaintext.length >= 8) values.add(plaintext);
      } else collect(parsed);
    } catch {
      if (plaintext.length >= 8) values.add(plaintext);
    }
  }
  return [...values];
}
