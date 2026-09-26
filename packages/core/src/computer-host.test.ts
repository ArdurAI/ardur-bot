import { afterEach, expect, it, vi } from "vitest";
import { isDesktopComposeStack, sandboxKindForBot } from "./computer-host.js";

afterEach(() => vi.unstubAllEnvs());

it("starts new computers on the host only on a desktop deployment or once the owner chose it", () => {
  // The desktop app's own stack is no exception: until Set up saves the choice, Docker stays.
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "api");
  vi.stubEnv("ARDURBOT_DESKTOP_STACK", "1");
  expect(sandboxKindForBot("desktop", null)).toBe("desktop");
  expect(sandboxKindForBot("docker", null)).toBe("docker");
  expect(sandboxKindForBot("docker", "this-mac")).toBe("desktop");
  expect(sandboxKindForBot("docker", "docker")).toBe("docker");
  expect(sandboxKindForBot("e2b", "this-mac")).toBe("e2b");
  expect(sandboxKindForBot("fake", "this-mac")).toBe("fake");
});

it("recognises the desktop app's own Compose stack only with its host bridge", () => {
  expect(isDesktopComposeStack({ ARDURBOT_HOST_BRIDGE: "api", ARDURBOT_DESKTOP_STACK: "1" })).toBe(
    true,
  );
  expect(isDesktopComposeStack({ ARDURBOT_HOST_BRIDGE: "api" })).toBe(false);
  expect(isDesktopComposeStack({ ARDURBOT_DESKTOP_STACK: "1" })).toBe(false);
});
