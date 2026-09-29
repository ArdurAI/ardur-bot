import type { ComputerConnectionSettings, ComputerProfileId } from "@ardurbot/contracts";
import { isPublishedComputerImage, resolveComputerImage } from "@ardurbot/contracts/computer-image";
import { APP_VERSION } from "../app-version.js";

type ConnectionImages = Pick<ComputerConnectionSettings, "standardImage" | "developerImage">;

/**
 * The image a saved connection's computer runs: the connection's own image, then the deployment's
 * `ARDURBOT_COMPUTER_IMAGE` for Standard, then the recorded digest or published channel tag.
 */
export function connectionComputerImage(
  profile: ComputerProfileId,
  settings: ConnectionImages,
  env: NodeJS.ProcessEnv = process.env,
) {
  const image = env.ARDURBOT_COMPUTER_IMAGE?.trim();
  // Compose appends the legacy tag to the name; read the same reference outside Compose.
  const tag = env.ARDURBOT_COMPUTER_IMAGE_TAG?.trim();
  const deployment = profile === "base" && image ? (tag ? `${image}:${tag}` : image) : undefined;
  return resolveComputerImage({
    profile,
    override:
      (profile === "developer" ? settings.developerImage : settings.standardImage) ?? deployment,
    appVersion: APP_VERSION,
    channel: env.ARDURBOT_COMPUTER_CHANNEL,
  });
}

/**
 * The owner's host cannot see the server's environment, so it starts only the connection's own
 * images or a published tag or digest.
 */
export function hostAcceptsComputerImage(image: string, settings: ConnectionImages) {
  return (
    image === settings.standardImage ||
    image === settings.developerImage ||
    isPublishedComputerImage(image)
  );
}
