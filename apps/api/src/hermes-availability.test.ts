import { expect, it } from "vitest";
import { hermesAvailabilityConnectionSupported } from "./hermes-availability.js";

it("omits a configured output cap that the Hermes host cannot launch", () => {
  expect(hermesAvailabilityConnectionSupported({ maxTokens: 65_536 })).toBe(true);
  expect(hermesAvailabilityConnectionSupported({ maxTokens: 131_072 })).toBe(false);
  expect(hermesAvailabilityConnectionSupported({ maxTokens: 0 })).toBe(false);
});
