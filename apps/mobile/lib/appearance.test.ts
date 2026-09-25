import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
const schemeListeners = new Set<(event: { colorScheme: "light" | "dark" | null }) => void>();
let colorScheme: "light" | "dark" | null = "dark";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  }),
}));

vi.mock("react-native", () => ({
  Appearance: {
    getColorScheme: () => colorScheme,
    addChangeListener: (listener: (event: { colorScheme: "light" | "dark" | null }) => void) => {
      schemeListeners.add(listener);
      return {
        remove() {
          schemeListeners.delete(listener);
        },
      };
    },
  },
}));

describe("mobile appearance", () => {
  beforeEach(() => {
    store.clear();
    schemeListeners.clear();
    colorScheme = "dark";
    vi.resetModules();
  });
  it("follows the OS even when an old device preference or desktop choice says otherwise", async () => {
    const { getCachedAppearancePreference, loadAppearancePreference, resolveMobileAppearance } =
      await import("./appearance");
    store.set("ardurbot.uiAppearance", "light");
    expect(await loadAppearancePreference()).toBe("system");
    expect(getCachedAppearancePreference()).toBe("system");
    expect(resolveMobileAppearance("light", "dark")).toBe("dark");
    expect(resolveMobileAppearance("dark", "light")).toBe("light");
  });
  it("updates mounted navigation and bubble tokens when the OS changes", async () => {
    const { mobileTokens, subscribeAppearance } = await import("./appearance");
    const listener = vi.fn();
    const unsubscribe = subscribeAppearance(listener);
    const before = mobileTokens();
    colorScheme = "light";
    for (const notify of schemeListeners) notify({ colorScheme: "light" });
    expect(listener).toHaveBeenCalledOnce();
    expect(mobileTokens().secondary).not.toBe(before.secondary);
    unsubscribe();
    for (const notify of schemeListeners) notify({ colorScheme: "dark" });
    expect(listener).toHaveBeenCalledOnce();
  });
});
