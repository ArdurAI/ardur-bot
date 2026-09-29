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

/**
 * The computer a newly created bot starts on. When the owner chose This Mac, new bots still
 * start on a Docker computer when the deployment has the Docker engine and the bot's runtime
 * supports non-host computers (the built-in Ardur runtime, "pi" — every native runtime is
 * host-only). A bot pinned to a native runtime keeps starting on the host. Existing bots
 * never change.
 */
export function defaultComputerKindForNewBot(
  envKind: string,
  computerHost: string | null | undefined,
  runtimeKind: string,
) {
  if (envKind === "docker" && computerHost === "this-mac" && runtimeKind === "pi") return "docker";
  return sandboxKindForBot(envKind, computerHost);
}
