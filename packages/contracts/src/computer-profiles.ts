import { z } from "zod";
import { COMPUTER_IMAGE_PINS } from "./computer-image.js";

/** Image tags and digests live beside the resolver in computer-image.js. */
export const COMPUTER_PROFILES = {
  base: {
    id: "base",
    label: "Standard",
    description: "Python and Chromium",
    ...COMPUTER_IMAGE_PINS.base,
    tools: ["python3", "chromium"],
  },
  developer: {
    id: "developer",
    label: "Developer (git, GitHub and GitLab CLIs, node, jq)",
    description: "Python, Chromium, git, gh, glab, jq, Node.js LTS, ripgrep and curl",
    ...COMPUTER_IMAGE_PINS.developer,
    tools: ["python3", "chromium", "git", "gh", "glab", "jq", "node", "npm", "rg", "curl"],
  },
} as const;
export type ComputerProfileId = keyof typeof COMPUTER_PROFILES;
export const ComputerProfileSchema = z.enum(
  Object.keys(COMPUTER_PROFILES) as [ComputerProfileId, ...ComputerProfileId[]],
);
export function computerProfileNote(profile: ComputerProfileId = "base") {
  const entry = COMPUTER_PROFILES[ComputerProfileSchema.parse(profile)];
  return `Computer image profile: ${entry.label}. Installed tools: ${entry.tools.join(", ")}. Vendor credentials are not installed. ${profile === "base" ? "git is not installed on this computer; ask the owner to switch it to the Developer profile." : "Cloud CLIs are not installed."}`;
}
export function missingProfileTool(profile: ComputerProfileId, command: string) {
  const tool = command.split("/").at(-1) ?? command;
  if (
    profile === "base" &&
    COMPUTER_PROFILES.developer.tools.some((item) => item === tool) &&
    !COMPUTER_PROFILES.base.tools.some((item) => item === tool)
  ) {
    return `${tool} is not installed on this computer; ask the owner to switch it to the Developer profile`;
  }
  return undefined;
}

export function profileCommandError(
  profile: ComputerProfileId,
  argv: string[],
  stderr: string,
  code: number,
) {
  if (code !== 127) return stderr;
  const missing = stderr.match(
    /(?:^|\s)(git|gh|glab|jq|node|npm|rg|curl): (?:command )?not found\b/,
  )?.[1];
  return missingProfileTool(profile, missing ?? argv[0] ?? "") ?? stderr;
}
