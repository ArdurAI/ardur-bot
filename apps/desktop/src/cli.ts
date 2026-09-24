/** Keep --version independent of window, updater, and local-stack startup. */
export function cliVersion(args: readonly string[], version: string): string | null {
  return args.includes("--version") ? `${version}\n` : null;
}
