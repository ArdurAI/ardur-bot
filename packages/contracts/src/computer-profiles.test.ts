import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMPUTER_IMAGE_PINS,
  isComputerImageReference,
  isPublishedComputerImage,
  localComputerImage,
  resolveComputerImage,
} from "./computer-image.js";
import {
  COMPUTER_PROFILES,
  ComputerProfileSchema,
  computerProfileNote,
  missingProfileTool,
} from "./computer-profiles.js";

describe("computer image registry", () => {
  it("keeps Standard the default and gives Developer an explicit versioned tag", () => {
    expect(ComputerProfileSchema.options).toEqual(Object.keys(COMPUTER_PROFILES));
    expect(Object.keys(COMPUTER_IMAGE_PINS)).toEqual(ComputerProfileSchema.options);
    expect(COMPUTER_PROFILES.developer.tag).toBe(`${COMPUTER_PROFILES.base.tag}-developer`);
    expect(localComputerImage()).toBe("ardurbot/computer:local");
    expect(localComputerImage("developer")).toBe(COMPUTER_PROFILES.developer.tag);
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
    expect(() =>
      resolveComputerImage({ profile: "missing" as "base", appVersion: "1.2.3" }),
    ).toThrow("profile");
  });
  it.each([
    [{ appVersion: "0.1.0-alpha.2" }, "ghcr.io/ardurai/ardur-bot/computer:dev"],
    [{ appVersion: "1.2.3" }, "ghcr.io/ardurai/ardur-bot/computer:1.2.3"],
    [
      { profile: "developer", appVersion: "0.1.0-alpha.2" },
      "ghcr.io/ardurai/ardur-bot/computer:dev-developer",
    ],
    [
      { profile: "developer", appVersion: "1.2.3" },
      "ghcr.io/ardurai/ardur-bot/computer:1.2.3-developer",
    ],
    [
      { profile: "developer", appVersion: "0.1.0-alpha.2", channel: "release" },
      "ghcr.io/ardurai/ardur-bot/computer:0.1.0-alpha.2-developer",
    ],
    [
      { profile: "developer", appVersion: "1.2.3", localPresent: true },
      "ardurbot/computer:0.1.0-developer",
    ],
    [
      { profile: "developer", appVersion: "1.2.3", override: " registry.example/dev:1 " },
      "registry.example/dev:1",
    ],
  ] as const)("resolves %j to %s", (input, expected) => {
    expect(resolveComputerImage(input)).toBe(expected);
  });
  it("accepts only bounded, well-formed image references", () => {
    for (const image of [
      "ghcr.io/ardurai/ardur-bot/computer:dev",
      "registry.example.com:5000/mirror/computer:v1.2.3",
      "[::1]:5000/computer",
      `ghcr.io/ardurai/ardur-bot/computer:dev@sha256:${"a".repeat(64)}`,
    ])
      expect(isComputerImageReference(image), image).toBe(true);
    for (const image of [
      "",
      " ghcr.io/computer:dev",
      "ghcr.io/computer: dev",
      "ghcr.io/computer:dev\n",
      "ghcr.io/Upper/computer",
      "ghcr.io/computer:-dev",
      "ghcr.io/computer@sha256:short",
      `ghcr.io/computer:${"t".repeat(129)}`,
      `registry.example/${"a".repeat(600)}`,
    ])
      expect(isComputerImageReference(image), image).toBe(false);
    expect(isPublishedComputerImage("ghcr.io/ardurai/ardur-bot/computer:1.2.3-developer")).toBe(
      true,
    );
    expect(isPublishedComputerImage("ghcr.io/ardurai/ardur-bot/computer-copy:dev")).toBe(false);
    expect(isPublishedComputerImage("ghcr.io/ardurai/ardur-bot/computer")).toBe(false);
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
