export const COMPUTER_IMAGE_DOWNLOAD_FAILED_CODE = "computer-image-download-failed";

export const COMPUTER_IMAGE_DOWNLOAD_REASONS = [
  "not found or private",
  "network error",
  "download failed",
] as const;
export type ComputerImageDownloadReason = (typeof COMPUTER_IMAGE_DOWNLOAD_REASONS)[number];

export function isComputerImageDownloadReason(
  value: unknown,
): value is ComputerImageDownloadReason {
  return COMPUTER_IMAGE_DOWNLOAD_REASONS.some((reason) => reason === value);
}

export function computerImageDownloadMessage(reason: ComputerImageDownloadReason): string {
  return `The bot computer image could not be downloaded: ${reason}. Check the network, or build it locally with \`pnpm build:computers\`.`;
}

export class ComputerImageDownloadError extends Error {
  constructor(
    readonly reason: ComputerImageDownloadReason,
    options?: ErrorOptions,
  ) {
    super(computerImageDownloadMessage(reason), options);
    this.name = "ComputerImageDownloadError";
  }
}
