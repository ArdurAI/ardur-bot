import { expect, it } from "vitest";
import type { FleetTarget } from "./fleet.js";
import {
  choosePlacement,
  EngineEndpointSchema,
  PlacementSettingsSchema,
  unknownCapacity,
} from "./fleet.js";

const now = Date.now();
const target = (id: string, free: number | null): FleetTarget => ({
  id,
  name: id,
  kind: "ssh",
  connectionId: id,
  state: "connected",
  bots: [],
  capacity: {
    ...unknownCapacity(),
    memoryFree: free === null ? null : free * 1024 ** 3,
    sampledAt: new Date(now).toISOString(),
  },
});
it("keeps manual placement, ranks fresh free memory and never selects unavailable measurements", () => {
  const targets = [
    target("host", 1.2),
    target("small", 3),
    target("large", 32),
    target("unknown", null),
    { ...target("offline", 100), state: "unavailable" as const },
    { ...target("discovered", 100), state: "discovered" as const },
  ];
  expect(choosePlacement(PlacementSettingsSchema.parse({}), "host", targets, now)).toBeNull();
  const policy = PlacementSettingsSchema.parse({ mode: "free-memory" });
  expect(choosePlacement(policy, "host", targets, now)?.targetId).toBe("large");
  expect(choosePlacement(policy, "large", targets, now)).toBeNull();
  expect(choosePlacement(policy, "host", targets, now + 31000)).toBeNull();
  expect(choosePlacement(policy, "host", [target("host", 8), target("tie", 8)], now)).toBeNull();
});
it("uses the threshold only at low capacity and records the measured reason", () => {
  const policy = PlacementSettingsSchema.parse({ mode: "threshold" });
  expect(choosePlacement(policy, "host", [target("host", 4), target("other", 16)], now)).toBeNull();
  expect(
    choosePlacement(policy, "host", [target("host", null), target("other", 16)], now),
  ).toBeNull();
  expect(choosePlacement(policy, "host", [target("host", 1), target("other", 3)], now)).toBeNull();
  expect(
    choosePlacement(policy, "host", [target("host", 1.2), target("other", 16)], now),
  ).toMatchObject({
    targetId: "other",
    reason: "host had 1.2 GB free",
    connectionId: "other",
    fromTargetId: "host",
  });
});
it("admits sockets, SSH and TLS, and refuses unauthenticated TCP or URL credentials", () => {
  for (const endpoint of [
    "unix:///fixture/engine.sock",
    "ssh://runner@computer.invalid",
    "tcp://computer.invalid:2376",
  ])
    expect(EngineEndpointSchema.safeParse(endpoint).success).toBe(true);
  for (const endpoint of [
    "tcp://computer.invalid:2375",
    "http://computer.invalid",
    "ssh://runner:secret@computer.invalid",
    "ssh://computer.invalid/path",
    "ssh://computer.invalid?command=bad",
  ])
    expect(EngineEndpointSchema.safeParse(endpoint).success).toBe(false);
});
