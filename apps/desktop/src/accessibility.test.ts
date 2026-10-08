import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ enabled: false, setEnabled: vi.fn() }));
vi.mock("electron", () => ({
  app: {
    get accessibilitySupportEnabled() {
      return fake.enabled;
    },
    set accessibilitySupportEnabled(value: boolean) {
      fake.enabled = value;
      fake.setEnabled(value);
    },
  },
}));

import { enableDesktopAccessibility } from "./accessibility.js";

beforeEach(() => {
  fake.enabled = false;
  fake.setEnabled.mockClear();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("desktop accessibility", () => {
  it("forces accessibility on and reports it once when explicitly enabled", () => {
    vi.stubEnv("ARDUR_DESKTOP_ACCESSIBILITY", "1");
    enableDesktopAccessibility();
    expect(fake.enabled).toBe(true);
    expect(fake.setEnabled).toHaveBeenCalledExactlyOnceWith(true);
    expect(console.info).toHaveBeenCalledExactlyOnceWith(
      "Accessibility tree forced on for automation.",
    );
  });

  it.each([undefined, "", "0", "true", "01", "1 ", " 1", "1\n"])(
    "preserves existing accessibility state for %j",
    (value) => {
      vi.stubEnv("ARDUR_DESKTOP_ACCESSIBILITY", value);
      for (const enabled of [false, true]) {
        fake.enabled = enabled;
        enableDesktopAccessibility();
        expect(fake.enabled).toBe(enabled);
        expect(fake.setEnabled).not.toHaveBeenCalled();
        expect(console.info).not.toHaveBeenCalled();
      }
    },
  );

  it("enables accessibility for development launches across platforms", () => {
    const desktop = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(desktop.scripts.dev).toBe(
      "pnpm build && cross-env ARDUR_DESKTOP_ACCESSIBILITY=1 electron .",
    );
    const turbo = JSON.parse(readFileSync(new URL("../../../turbo.json", import.meta.url), "utf8"));
    expect(turbo.tasks.dev.passThroughEnv).toContain("ARDUR_DESKTOP_ACCESSIBILITY");
  });
});
