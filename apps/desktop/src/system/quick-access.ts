import { mkdir } from "node:fs/promises";
import path from "node:path";
import { readPrivateFile, writePrivateFile } from "../setup-store.js";

export interface QuickAccessIdentity {
  userId: string;
  spaceId: string;
}

export function quickIdentity(value: unknown): QuickAccessIdentity {
  if (
    !value ||
    typeof value !== "object" ||
    !("userId" in value) ||
    !("spaceId" in value) ||
    !validId(value.userId) ||
    !validId(value.spaceId)
  )
    throw new Error("Choose an available bot.");
  return { userId: value.userId, spaceId: value.spaceId };
}
export function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value);
}

/** One remembered destination, bound to the current server, account and space. */
export class QuickAccessStore {
  constructor(private readonly directory: string) {}
  async get(origin: string, identity: QuickAccessIdentity): Promise<string | null> {
    const raw = await readPrivateFile(path.join(this.directory, "quick-access.json"), 4096);
    try {
      const saved = raw ? JSON.parse(raw) : null;
      return saved?.origin === origin &&
        saved.userId === identity.userId &&
        saved.spaceId === identity.spaceId &&
        validId(saved.botId)
        ? saved.botId
        : null;
    } catch {
      return null;
    }
  }
  async set(origin: string, identity: QuickAccessIdentity, botId: unknown) {
    if (!validId(botId)) throw new Error("Choose an available bot.");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writePrivateFile(
      path.join(this.directory, "quick-access.json"),
      JSON.stringify({ origin, ...identity, botId }),
    );
  }
}
