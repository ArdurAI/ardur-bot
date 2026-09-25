// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_USER_PREFERENCES } from "@ardurbot/contracts";
import { beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }));
vi.mock("./rpc", () => ({ rpc: { preferences: fake } }));

import {
  applyPreferences,
  cachedPreferences,
  loadPreferences,
  resetPreferences,
  savePreferencesCache,
  updatePreferences,
} from "./preferences";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  resetPreferences();
  vi.clearAllMocks();
});
it("shares the shell read, scopes cache by account, and applies all three attributes", async () => {
  const preferences = {
    ...DEFAULT_USER_PREFERENCES,
    theme: "light" as const,
    chatFont: "serif" as const,
    motion: "reduced" as const,
  };
  fake.get.mockResolvedValue(preferences);
  await Promise.all([loadPreferences("one"), loadPreferences("one")]);
  expect(fake.get).toHaveBeenCalledOnce();
  applyPreferences(preferences);
  expect(document.documentElement.dataset).toMatchObject({
    theme: "light",
    chatFont: "serif",
    motion: "reduced",
  });
  expect(cachedPreferences("one")).toEqual(preferences);
  expect(cachedPreferences("two")).toBeNull();
  fake.update.mockResolvedValue({ preferences: { ...preferences, motion: "system" } });
  await updatePreferences("one", { motion: "system" });
  expect(cachedPreferences("one")?.motion).toBe("system");
  resetPreferences();
  expect(cachedPreferences("one")).toBeNull();
});
it("keeps failed updates out of the startup cache and retries failed reads", async () => {
  savePreferencesCache("one", DEFAULT_USER_PREFERENCES);
  fake.update.mockRejectedValue(new Error("offline"));
  await expect(updatePreferences("one", { theme: "dark" })).rejects.toThrow("offline");
  expect(cachedPreferences("one")?.theme).toBe("system");
  fake.get.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(DEFAULT_USER_PREFERENCES);
  await expect(loadPreferences("one")).rejects.toThrow();
  await loadPreferences("one");
  expect(fake.get).toHaveBeenCalledTimes(2);
});
it("ships pre-paint attributes, token font stacks and explicit and OS motion rules", () => {
  const css = readFileSync(resolve("apps/web/src/styles.css"), "utf8");
  const html = readFileSync(resolve("apps/web/index.html"), "utf8");
  expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  expect(css).toContain('[data-motion="reduced"]');
  expect(css).toContain("font-family: var(--chat-font-serif)");
  expect(html.indexOf("dataset.chatFont")).toBeLessThan(html.indexOf('<div id="root">'));
  expect(html).toContain("dataset.motion");
});
