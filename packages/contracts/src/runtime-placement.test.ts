import { describe, expect, it } from "vitest";
import {
  COMPUTER_KINDS,
  ComputerConfigurationSchema,
  ComputerReplacementConfigurationSchema,
} from "./computer-connections.js";
import { RuntimeKindSchema } from "./runtime-pins.js";
import {
  computerExecutionKind,
  computerRunsOnHost,
  defaultNewBotLocation,
  newBotSandboxAvailable,
  newBotTeamLocation,
  newBotTeamLocationConflict,
  RUNTIME_PLACEMENT_RULES,
  runtimeSupportsLocation,
} from "./runtime-placement.js";

const locations = [
  ...Object.keys(COMPUTER_KINDS).map((kind) => ({ kind })),
  ...(["docker", "podman", "kubernetes", "ssh"] as const).map((engine) => ({
    kind: "desktop",
    connectionId: "saved",
    connectionSettings: { engine },
  })),
  { kind: "desktop", connectionId: "missing" },
  { kind: "desktop", connectionId: "" },
  { kind: "unknown" },
  {},
];
describe("new bot location default", () => {
  it("defaults to the usable host when the sandbox override has no sandbox", () => {
    expect(
      defaultNewBotLocation({
        isDeploymentOwner: true,
        hostConnected: true,
        hostPaired: true,
        computerHost: "docker",
        sandboxAvailable: false,
      }),
    ).toBe("host");
  });
  for (const isDeploymentOwner of [true, false])
    for (const hostConnected of [true, false])
      for (const hostPaired of [true, false])
        it(`owner=${isDeploymentOwner}, connected=${hostConnected}, paired=${hostPaired}`, () => {
          const facts = { isDeploymentOwner, hostConnected, hostPaired };
          const expected = isDeploymentOwner && hostConnected && hostPaired ? "host" : "sandbox";
          expect(defaultNewBotLocation(facts)).toBe(expected);
          expect(defaultNewBotLocation({ ...facts, computerHost: "this-mac" })).toBe(expected);
          expect(defaultNewBotLocation({ ...facts, computerHost: "docker" })).toBe("sandbox");
        });
});
it.each(Object.keys(COMPUTER_KINDS))(
  "Sandbox availability uses the deployment provider without relabeling %s",
  (provider) => {
    expect(newBotSandboxAvailable(provider, null)).toBe(provider !== "desktop");
    expect(newBotSandboxAvailable(provider, { connectionId: "saved" })).toBe(true);
  },
);
it.each([
  [{ kind: "none" }, { kind: "none" }, false],
  [{ kind: "unknown" }, { kind: "fake" }, false],
  [{ kind: "docker" }, { kind: "fake" }, false],
  [{ kind: "remote-docker" }, { kind: "docker" }, false],
  [{ kind: "docker" }, { kind: "desktop", connectionId: "saved" }, true],
  [{ kind: "desktop" }, { kind: "none" }, true],
  [{ kind: "none" }, { kind: "desktop" }, true],
  [{ kind: "desktop" }, { kind: "desktop" }, false],
  [
    { kind: "desktop", connectionId: "saved" },
    { kind: "remote-docker", connectionId: "saved" },
    false,
  ],
  [
    { kind: "desktop", connectionId: "first" },
    { kind: "remote-docker", connectionId: "second" },
    true,
  ],
] as const)(
  "compares Team joins by host and saved connection: %j / %j",
  (team, requested, conflict) => {
    expect(newBotTeamLocation(team)).toBe(computerRunsOnHost(team) ? "host" : "sandbox");
    expect(newBotTeamLocationConflict(team, requested)).toBe(conflict);
    expect(newBotTeamLocationConflict(requested, team)).toBe(conflict);
  },
);
it.each(locations)("grants host authority only to connectionless desktop: %j", (location) => {
  expect(computerRunsOnHost(location)).toBe(
    location.kind === "desktop" && !("connectionId" in location),
  );
});
describe.each(RuntimeKindSchema.options)("%s placement", (runtime) => {
  it.each(locations)("admits only the supported concrete location: %j", (location) => {
    const kind = computerExecutionKind(location);
    const expected = runtime === "pi" ? kind !== null : kind === "desktop";
    expect(runtimeSupportsLocation(runtime, location)).toBe(expected);
  });
});
it("has one exhaustive entry per runtime and never treats connected desktop rows as host", () => {
  expect(Object.keys(RUNTIME_PLACEMENT_RULES).sort()).toEqual(
    [...RuntimeKindSchema.options].sort(),
  );
  expect(
    computerExecutionKind({
      kind: "desktop",
      connectionId: "engine",
      connectionSettings: { engine: "docker" },
    }),
  ).toBe("remote-docker");
});
it("requires an explicit unambiguous host destination", () => {
  expect(
    ComputerConfigurationSchema.parse({ botId: "bot", destination: "host", confirmed: true }),
  ).toEqual({ botId: "bot", destination: "host", confirmed: true });
  for (const connectionId of [null, "connection"])
    for (const schema of [ComputerConfigurationSchema, ComputerReplacementConfigurationSchema])
      expect(
        schema.safeParse({ botId: "bot", destination: "host", connectionId, confirmed: true })
          .success,
      ).toBe(false);
  for (const schema of [ComputerConfigurationSchema, ComputerReplacementConfigurationSchema])
    expect(schema.safeParse({ botId: "bot", connectionId: "", confirmed: true }).success).toBe(
      false,
    );
});
