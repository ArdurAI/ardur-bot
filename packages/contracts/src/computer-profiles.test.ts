import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMPUTER_PROFILES,
  ComputerProfileSchema,
  computerImage,
  computerProfileNote,
  missingProfileTool,
} from "./computer-profiles.js";

describe("computer image registry", () => {
  it("keeps Standard the default and gives Developer an explicit versioned tag", () => {
    expect(ComputerProfileSchema.options).toEqual(Object.keys(COMPUTER_PROFILES));
    expect(computerImage()).toBe(COMPUTER_PROFILES.base.tag);
    expect(computerImage("developer")).toBe(`${COMPUTER_PROFILES.base.tag}-developer`);
    for (const profile of Object.values(COMPUTER_PROFILES)) {
      expect(profile.digest === null || /^sha256:[a-f0-9]{64}$/.test(profile.digest)).toBe(true);
      expect(profile.tools).not.toContain("aws");
    }
    expect(readFileSync("scripts/build-computers.ts", "utf8")).toContain(
      "Object.values(COMPUTER_PROFILES)",
    );
    expect(readFileSync("infra/sandboxes/computer/Dockerfile", "utf8")).toContain(
      "ARG IMAGE_PROFILE=base",
    );
    expect(() => computerImage("missing" as "base")).toThrow();
  });
  it("describes tools accurately and supplies an actionable missing-command sentence", () => {
    expect(computerProfileNote("base")).toContain("Installed tools: python3, chromium.");
    expect(computerProfileNote("developer")).toContain("git, gh, glab, jq, node, npm, rg, curl");
    expect(missingProfileTool("base", "git")).toBe(
      "git is not installed on this computer; ask the owner to switch it to the Developer profile",
    );
    expect(missingProfileTool("developer", "git")).toBeUndefined();
    expect(missingProfileTool("base", "python3")).toBeUndefined();
  });
});
