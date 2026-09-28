import { describe, expect, it } from "vitest";
import { filterHostEnvironment } from "./host-environment.js";

describe("host environment", () => {
  it("passes only an absolute Hermes install path", () => {
    expect(filterHostEnvironment({ ARDUR_HERMES_INSTALL: "/fixture/hermes" })).toEqual({
      ARDUR_HERMES_INSTALL: "/fixture/hermes",
    });
    for (const value of [
      "relative/hermes",
      "/fixture/hermes\ninvalid",
      "/fixture/hermes\0invalid",
    ]) {
      expect(filterHostEnvironment({ ARDUR_HERMES_INSTALL: value })).toEqual({});
    }
    expect(filterHostEnvironment({})).toEqual({});
    expect(filterHostEnvironment({ ARDUR_HERMES_INSTALL: "C:\\fixture\\hermes" })).toEqual({});
    expect(filterHostEnvironment({ ARDUR_HERMES_INSTALL: "C:\\fixture\\hermes" }, "win32")).toEqual(
      { ARDUR_HERMES_INSTALL: "C:\\fixture\\hermes" },
    );
  });
});
