import { describe, expect, it } from "vitest";
import { cliVersion } from "./cli.js";

describe("desktop version CLI", () => {
  it("prints the packaged app version including the pre-release suffix", () => {
    expect(cliVersion(["ardur-bot", "--version"], "0.1.0-alpha.1")).toBe("0.1.0-alpha.1\n");
  });
  it("leaves normal startup untouched", () => {
    expect(cliVersion(["ardur-bot"], "0.1.0")).toBeNull();
  });
});
