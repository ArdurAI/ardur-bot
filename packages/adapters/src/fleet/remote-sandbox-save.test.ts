import type { AdapterContext, ComputerRef } from "@ardurbot/adapter-kit";
import { ComputerConnectionSettingsSchema, ComputerWorkspaceSaveError } from "@ardurbot/contracts";
import { fleetComputerKey } from "@ardurbot/host-runtime/fleet/linux-sandbox";
import type { HostClient } from "@ardurbot/host-runtime/host-client";
import { expect, it, vi } from "vitest";
import { RemoteFleetSandbox } from "./remote-sandbox.js";

const context: AdapterContext = {
  userId: "owner",
  spaceId: "space",
  operationId: "update",
  traceId: "update",
  signal: new AbortController().signal,
};
const computer: ComputerRef = {
  id: "computer",
  botId: "home",
  kind: "remote-docker",
  providerRef: `ardurbot-${fleetComputerKey("space", "home").slice(0, 40)}`,
};
const settings = ComputerConnectionSettingsSchema.parse({
  engine: "docker",
  endpoint: "unix:///fixture/engine.sock",
});

it.each([
  undefined,
  { ok: false, reason: "private-output" },
  { ok: false, reason: "save-failed", engineFailureCategory: "private-output" },
])("fails closed when readiness has no valid safe acknowledgement: %j", async (data) => {
  const client: Pick<HostClient, "request"> = {
    async *request() {
      if (data !== undefined)
        yield { v: 1, type: "stream", id: "fixture", seq: 0, channel: "result", data };
    },
  };
  const provider = new RemoteFleetSandbox("engine", settings, client);
  const ready = provider.ensureWorkspaceReady(computer, context);
  await expect(ready).rejects.toBeInstanceOf(ComputerWorkspaceSaveError);
  await expect(ready).rejects.toMatchObject({
    reason: "save-failed",
    engineFailureCategory: "command-failed",
  });
});

it("refuses a foreign source reference before contacting the bridge", async () => {
  const request = vi.fn();
  const provider = new RemoteFleetSandbox("engine", settings, { request });
  await expect(
    provider.ensureWorkspaceReady({ ...computer, providerRef: "foreign" }, context),
  ).rejects.toMatchObject({ reason: "save-failed", engineFailureCategory: "source-not-owned" });
  expect(request).not.toHaveBeenCalled();
});
