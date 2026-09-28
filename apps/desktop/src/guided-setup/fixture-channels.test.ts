import { GUIDED_SETUP_CHANNELS } from "@ardurbot/contracts/desktop-setup";
import { describe, expect, it } from "vitest";
import { GUIDED_SETUP_FIXTURE_REQUEST_CHANNELS } from "../../e2e/guided-setup-fixture-channels.js";

describe("guided setup lifecycle fixture", () => {
  it("removes every request handler before installing its engine", () => {
    const requestChannels = Object.values(GUIDED_SETUP_CHANNELS).filter(
      (channel) => channel !== GUIDED_SETUP_CHANNELS.changed,
    );
    expect(GUIDED_SETUP_FIXTURE_REQUEST_CHANNELS).toEqual(requestChannels);
  });
});
