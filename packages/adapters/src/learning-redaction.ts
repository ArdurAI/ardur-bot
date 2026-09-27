import type { PrismaClient } from "@ardurbot/db";
import type { OAuthMaterial } from "./mcp-oauth.js";
import { oauthMaterialSecrets } from "./mcp-oauth.js";
import type { EncryptedSecretStore } from "./secrets.js";

/** Only encrypted credential slots enter the shared exact-match redactor. */
export async function learningSecrets(
  prisma: PrismaClient,
  store: EncryptedSecretStore,
  scope: { spaceId: string; userId: string; botId: string },
): Promise<string[]> {
  const [secrets, botSecrets] = await Promise.all([
    prisma.secret.findMany({
      where: { OR: [{ spaceId: scope.spaceId }, { userId: scope.userId, spaceId: null }] },
      select: { id: true, kind: true, ciphertext: true },
    }),
    prisma.botSecret.findMany({
      where: { spaceId: scope.spaceId, userId: scope.userId, botId: scope.botId },
      select: { id: true, ciphertext: true },
    }),
  ]);
  const values = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value.length > 0) values.add(value);
  };
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  for (const secret of secrets) {
    const plaintext = store.load(secret.ciphertext, secret.id);
    if (
      secret.kind === "agent-environment" ||
      secret.kind === "webhook" ||
      secret.kind?.startsWith("run-secret:")
    ) {
      add(plaintext);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      add(plaintext);
      continue;
    }
    if (typeof parsed === "string") {
      add(parsed);
      continue;
    }
    if (parsed === null || typeof parsed !== "object") {
      add(plaintext);
      continue;
    }
    const data = record(parsed);
    if (secret.kind === "mcp") {
      for (const value of oauthMaterialSecrets(data as OAuthMaterial)) add(value);
    } else if (secret.kind === "model") {
      // A raw key, an OAuth object, or a compatible connection object.
      add(data.access);
      add(data.refresh);
      add(data.apiKey);
      add(data.key);
      const credential = record(data.credential);
      add(credential.access);
      add(credential.refresh);
      add(credential.value);
    } else if (secret.kind === "memory-provider") {
      // This record is already a credential map; keys are names, values are credentials.
      for (const value of Object.values(data)) add(value);
    } else if (secret.kind === "memory-git") {
      add(data.value);
    } else if (secret.kind === "computer") {
      add(data.inline);
    } else {
      // Other structured secret records use explicit credential slots.
      add(data.secret);
      add(data.token);
      add(data.apiKey);
      add(data.password);
      add(record(data.credential).value);
    }
  }
  for (const secret of botSecrets) add(store.load(secret.ciphertext, secret.id));
  return [...values];
}
