/**
 * The Compose stack the desktop app runs for the person who installed it. It never asks where
 * bots run: pairing its host service with Set up chooses that computer.
 */
export function isDesktopComposeStack(env: Record<string, string | undefined> = process.env) {
  return env.ARDURBOT_HOST_BRIDGE === "api" && env.ARDURBOT_DESKTOP_STACK === "1";
}

/**
 * The kind a new computer gets: the host on a desktop deployment, or on Docker once the owner
 * chose the host. Existing computers keep the kind they were created with.
 */
export function sandboxKindForBot(envKind: string, computerHost: string | null | undefined) {
  return envKind === "docker" && computerHost === "this-mac" ? "desktop" : envKind;
}
