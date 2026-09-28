import type { AdapterContext } from "@ardurbot/adapter-kit";
import { ComputerConnectionSettingsSchema } from "@ardurbot/contracts";
import { expect, it } from "vitest";
import { RemoteFleetSandbox } from "./remote-sandbox.js";

it("transports an allowlisted host engine failure as a typed test failure", async () => {
  const settings = ComputerConnectionSettingsSchema.parse({
    engine: "docker",
    endpoint: "unix:///fixture/docker.sock",
  });
  const client = {
    request: async function* () {
      yield {
        channel: "result",
        data: { error: "engine-probe-failed", reason: "permission-denied" },
      };
    },
  };
  const provider = new RemoteFleetSandbox("saved", settings, client as never);
  const context: AdapterContext = {
    userId: "owner",
    spaceId: "space",
    operationId: "test",
    traceId: "test",
    signal: new AbortController().signal,
  };
  await expect(provider.test(context)).rejects.toThrow("permission-denied");
});
