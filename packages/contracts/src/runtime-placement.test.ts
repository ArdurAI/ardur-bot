import { describe, expect, it } from "vitest";
import {
  COMPUTER_KINDS,
  ComputerConfigurationSchema,
  ComputerReplacementConfigurationSchema,
} from "./computer-connections.js";
import { RuntimeKindSchema } from "./runtime-pins.js";
import {
  computerExecutionKind,
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
