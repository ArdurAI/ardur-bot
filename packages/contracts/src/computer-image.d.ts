export const LOCAL_COMPUTER_IMAGE: "ardurbot/computer:local";
export const PUBLISHED_COMPUTER_IMAGE: "ghcr.io/ardurai/ardur-bot/computer";
export const COMPUTER_IMAGE_PINS: {
  readonly base: { readonly tag: "ardurbot/computer:0.1.0"; readonly digest: string | null };
  readonly developer: {
    readonly tag: "ardurbot/computer:0.1.0-developer";
    readonly digest: string | null;
  };
};
export const MAX_COMPUTER_IMAGE_LENGTH: 512;

export function isComputerImageReference(value: unknown): value is string;

export function isPublishedComputerImage(image: string): boolean;

export function localComputerImage(profile?: "base" | "developer"): string;

export function resolveComputerImage(input: {
  profile?: "base" | "developer";
  override?: string;
  localPresent?: boolean;
  appVersion: string;
  channel?: string;
}): string;
