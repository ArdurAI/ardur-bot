/**
 * The Compose stack the desktop app runs for the person who installed it. Its host bridge reaches
 * that same computer, so the host is where their work starts.
 */
export function isDesktopComposeStack(env: Record<string, string | undefined> = process.env) {
  return env.ARDURBOT_HOST_BRIDGE === "api" && env.ARDURBOT_DESKTOP_STACK === "1";
}

/**
 * The kind a new computer gets. A Docker deployment starts it on the host when the owner chose
 * the host, and on the desktop app's own stack unless the owner chose Docker. Existing computers
 * keep the kind they were created with.
 */
export function sandboxKindForBot(
  envKind: string,
  computerHost: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
) {
  if (envKind !== "docker") return envKind;
  if (computerHost === "this-mac") return "desktop";
  return computerHost == null && isDesktopComposeStack(env) ? "desktop" : envKind;
}
