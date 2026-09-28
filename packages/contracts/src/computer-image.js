export const LOCAL_COMPUTER_IMAGE = "ardurbot/computer:local";
const PUBLISHED_COMPUTER_IMAGE = "ghcr.io/ardurai/ardur-bot/computer";

/**
 * @param {{ override?: string; localPresent: boolean; appVersion: string; channel?: string }} input
 */
export function resolveComputerImage(input) {
  const override = input.override?.trim();
  if (override) return override;
  if (input.localPresent) return LOCAL_COMPUTER_IMAGE;
  const selectedChannel = input.channel?.trim() || undefined;
  if (selectedChannel && selectedChannel !== "dev" && selectedChannel !== "release") {
    throw new Error("ARDURBOT_COMPUTER_CHANNEL must be dev or release");
  }
  const version = input.appVersion;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("The application version cannot select a computer image");
  }
  const channel = selectedChannel ?? (version.includes("-") ? "dev" : "release");
  return `${PUBLISHED_COMPUTER_IMAGE}:${channel === "dev" ? "dev" : version}`;
}
