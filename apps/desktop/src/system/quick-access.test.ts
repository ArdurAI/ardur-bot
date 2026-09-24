import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { QuickAccessStore, quickIdentity } from "./quick-access.js";

it("remembers the chosen bot only for the same server, user and space", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "system-quick-"));
  try {
    const store = new QuickAccessStore(directory),
      identity = { userId: "user", spaceId: "space" };
    const origin = "https://home.example.invalid";
    expect(await store.get(origin, identity)).toBeNull();
    await store.set(origin, identity, "coordinator");
    expect(await new QuickAccessStore(directory).get(origin, identity)).toBe("coordinator");
    expect(await store.get("https://another.example.invalid", identity)).toBeNull();
    expect(await store.get(origin, { ...identity, userId: "another" })).toBeNull();
    expect(await store.get(origin, { ...identity, spaceId: "another" })).toBeNull();
    await expect(store.set(origin, identity, "../bad")).rejects.toThrow("available bot");
    expect(() => quickIdentity({ userId: {}, spaceId: "space" })).toThrow("available bot");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
