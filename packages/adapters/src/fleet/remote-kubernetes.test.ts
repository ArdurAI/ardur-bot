import type { AdapterContext } from "@ardurbot/adapter-kit";
import { ComputerConnectionSettingsSchema } from "@ardurbot/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { HostKubernetesSandboxProvider } from "./remote-kubernetes.js";

const context: AdapterContext = {
  userId: "owner",
  spaceId: "space",
  operationId: "test",
  traceId: "test",
  signal: new AbortController().signal,
};
const settings = ComputerConnectionSettingsSchema.parse({
  engine: "kubernetes",
  context: "fixture",
});
afterEach(() => {
  vi.unstubAllEnvs();
});

it("explains a deployment image the owner's host will not start before asking it", async () => {
  vi.stubEnv("ARDURBOT_COMPUTER_IMAGE", "mirror.example/computer:2");
  const request = vi.fn();
  const provider = new HostKubernetesSandboxProvider("saved", settings, { request });
  await expect(provider.provision({ botId: "bot", homePath: "/unused" }, context)).rejects.toThrow(
    "Set this cluster's image under Advanced on its connection",
  );
  expect(request).not.toHaveBeenCalled();
});
