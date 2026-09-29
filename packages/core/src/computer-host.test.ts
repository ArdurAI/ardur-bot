import { expect, it } from "vitest";
import {
  defaultComputerKindForNewBot,
  isDesktopComposeStack,
  sandboxKindForBot,
} from "./computer-host.js";

it("starts new computers on the host only on a desktop deployment or once the owner chose it", () => {
  expect(sandboxKindForBot("desktop", null)).toBe("desktop");
  expect(sandboxKindForBot("docker", null)).toBe("docker");
  expect(sandboxKindForBot("docker", "this-mac")).toBe("desktop");
  expect(sandboxKindForBot("docker", "docker")).toBe("docker");
  expect(sandboxKindForBot("e2b", "this-mac")).toBe("e2b");
  expect(sandboxKindForBot("fake", "this-mac")).toBe("fake");
});

it("starts new bots on Docker when the engine is available and the runtime supports it", () => {
  // This Mac chosen + built-in runtime: Docker instead of the host.
  expect(defaultComputerKindForNewBot("docker", "this-mac", "pi")).toBe("docker");
  expect(defaultComputerKindForNewBot("docker", "docker", "pi")).toBe("docker");
  // Native runtimes are host-only: a pinned bot still starts on This Mac.
  expect(defaultComputerKindForNewBot("docker", "this-mac", "claude-code")).toBe("desktop");
  expect(defaultComputerKindForNewBot("docker", "this-mac", "codex-app-server")).toBe("desktop");
  expect(defaultComputerKindForNewBot("docker", "this-mac", "antigravity")).toBe("desktop");
  expect(defaultComputerKindForNewBot("docker", "this-mac", "hermes")).toBe("desktop");
  // No Docker engine configured anywhere: the host stays the default.
  expect(defaultComputerKindForNewBot("desktop", null, "pi")).toBe("desktop");
  expect(defaultComputerKindForNewBot("none", null, "pi")).toBe("none");
  expect(defaultComputerKindForNewBot("e2b", null, "pi")).toBe("e2b");
});

it("recognises the desktop app's own Compose stack only with its host bridge", () => {
  expect(isDesktopComposeStack({ ARDURBOT_HOST_BRIDGE: "api", ARDURBOT_DESKTOP_STACK: "1" })).toBe(
    true,
  );
  expect(isDesktopComposeStack({ ARDURBOT_HOST_BRIDGE: "api" })).toBe(false);
  expect(isDesktopComposeStack({ ARDURBOT_DESKTOP_STACK: "1" })).toBe(false);
});
