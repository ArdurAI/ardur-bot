export const LOCAL_COMPUTER_IMAGE = "ardurbot/computer:local";
export const PUBLISHED_COMPUTER_IMAGE = "ghcr.io/ardurai/ardur-bot/computer";

/**
 * The tag `pnpm build:computers` gives each profile, and its published manifest digest. Published
 * digests are recorded here, never inferred from mutable registry tags.
 */
export const COMPUTER_IMAGE_PINS = {
  base: { tag: "ardurbot/computer:0.1.0", digest: null },
  developer: { tag: "ardurbot/computer:0.1.0-developer", digest: null },
};

// The distribution reference grammar: an optional registry host, a lowercase repository path, then
// an optional tag and digest. Only the name is length-bounded by the grammar; bound the whole too.
const DOMAIN = String.raw`(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*|\[[a-fA-F0-9:]+\])(?::[0-9]+)?`;
const PATH = String.raw`[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*`;
const IMAGE_REFERENCE = new RegExp(
  String.raw`^((?:${DOMAIN}/)?${PATH}(?:/${PATH})*)(?::\w[\w.-]{0,127})?(?:@[A-Za-z][A-Za-z0-9]*(?:[-_+.][A-Za-z][A-Za-z0-9]*)*:[0-9a-fA-F]{32,})?$`,
);
export const MAX_COMPUTER_IMAGE_LENGTH = 512;

/** @param {unknown} value */
export function isComputerImageReference(value) {
  if (typeof value !== "string" || value.length > MAX_COMPUTER_IMAGE_LENGTH) return false;
  const name = IMAGE_REFERENCE.exec(value)?.[1];
  return name !== undefined && name.length <= 255;
}

/** A tag or digest of the image this project publishes. @param {string} image */
export function isPublishedComputerImage(image) {
  return (
    isComputerImageReference(image) &&
    (image.startsWith(`${PUBLISHED_COMPUTER_IMAGE}:`) ||
      image.startsWith(`${PUBLISHED_COMPUTER_IMAGE}@`))
  );
}

/** The image `pnpm build:computers` builds for a profile on this machine. @param {"base" | "developer"} profile */
export function localComputerImage(profile = "base") {
  return profile === "developer" ? COMPUTER_IMAGE_PINS.developer.tag : LOCAL_COMPUTER_IMAGE;
}

/**
 * One order for every computer: an explicit image, a local build the caller found, the recorded
 * digest, then the published channel tag. Developer adds `-developer` to the published tag.
 * @param {{ profile?: "base" | "developer"; override?: string; localPresent?: boolean; appVersion: string; channel?: string }} input
 */
export function resolveComputerImage(input) {
  const profile = input.profile ?? "base";
  if (profile !== "base" && profile !== "developer") throw new Error("Unknown computer profile");
  const override = input.override?.trim();
  if (override) return override;
  if (input.localPresent) return localComputerImage(profile);
  const digest = COMPUTER_IMAGE_PINS[profile].digest;
  if (digest) return `${PUBLISHED_COMPUTER_IMAGE}@${digest}`;
  const selectedChannel = input.channel?.trim() || undefined;
  if (selectedChannel && selectedChannel !== "dev" && selectedChannel !== "release") {
    throw new Error("ARDURBOT_COMPUTER_CHANNEL must be dev or release");
  }
  const version = input.appVersion;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("The application version cannot select a computer image");
  }
  const channel = selectedChannel ?? (version.includes("-") ? "dev" : "release");
  const tag = channel === "dev" ? "dev" : version;
  return `${PUBLISHED_COMPUTER_IMAGE}:${tag}${profile === "developer" ? "-developer" : ""}`;
}
