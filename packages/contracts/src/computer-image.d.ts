export const LOCAL_COMPUTER_IMAGE: "ardurbot/computer:local";

export function resolveComputerImage(input: {
  override?: string;
  localPresent: boolean;
  appVersion: string;
  channel?: string;
}): string;
