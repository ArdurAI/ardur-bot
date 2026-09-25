import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOwnerPreviews } from "./pending-previews.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(async () => {
  await vi.advanceTimersByTimeAsync(60_000);
  vi.useRealTimers();
});

it("bounds previews across owners and stores without evicting another owner's live preview", () => {
  const first = createOwnerPreviews<{ expires: number }>();
  const second = createOwnerPreviews<{ expires: number }>();
  for (let i = 0; i < 256; i++)
    first({ spaceId: "space", userId: `owner-${i}` }).set("preview", { expires: 1000 });
  const other = second({ spaceId: "other", userId: "owner" });
  expect(() => other.set("preview", { expires: 2000 })).toThrow("Too many pending previews");
  expect(first({ spaceId: "space", userId: "owner-0" }).get("preview")).toEqual({ expires: 1000 });
  expect(other.get("preview")).toBeUndefined();
  expect(first({ spaceId: "other", userId: "owner-0" }).get("preview")).toBeUndefined();
  first({ spaceId: "space", userId: "owner-0" }).delete("preview");
  expect(() => other.set("preview", { expires: 2000 })).not.toThrow();
});

it("reclaims expired entries before refusing capacity and permits replacement at the cap", () => {
  const previews = createOwnerPreviews<{ expires: number }>();
  const owner = previews({ spaceId: "space", userId: "owner" });
  for (let i = 0; i < 256; i++) owner.set(`preview-${i}`, { expires: i === 0 ? 1000 : 2000 });
  expect(() => owner.set("preview-1", { expires: 3000 })).not.toThrow();
  vi.setSystemTime(1000);
  const other = previews({ spaceId: "space", userId: "other" });
  expect(() => other.set("new", { expires: 2000 })).not.toThrow();
  expect(owner.get("preview-0")).toBeUndefined();
  expect(owner.get("preview-1")).toEqual({ expires: 3000 });
  expect(() => other.set("overflow", { expires: 2000 })).toThrow("Too many pending previews");
});

it("releases expired payloads without another request and cleans up the expiry timer", async () => {
  const previews = createOwnerPreviews<{ expires: number; payload: Uint8Array }>();
  const owner = previews({ spaceId: "space", userId: "owner" });
  owner.set("later", { expires: 2000, payload: new Uint8Array(8) });
  owner.set("earlier", { expires: 1000, payload: new Uint8Array(8) });
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(owner.size).toBe(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(owner.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
