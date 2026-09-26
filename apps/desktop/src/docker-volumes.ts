import type { RunDocker } from "./docker-cli.js";

const DECIMAL_UNIT_BYTES: Record<string, number> = {
  b: 1,
  kb: 1_000,
  mb: 1_000 ** 2,
  gb: 1_000 ** 3,
  tb: 1_000 ** 4,
  pb: 1_000 ** 5,
};

/**
 * `docker system df` prints go-units decimal sizes ("71.52MB", "0B", "1.64GB"), not the
 * binary (KiB/MiB) units `du` uses. Returns null for anything that does not match.
 */
export function parseDockerSize(text: string): number | null {
  const match = /^([\d.]+)\s*([a-zA-Z]?)i?[bB]$/.exec(text.trim());
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const factor = DECIMAL_UNIT_BYTES[`${match[2]!.toLowerCase()}b`];
  return factor === undefined ? null : Math.round(value * factor);
}

/**
 * Asks the Docker daemon for the size of specific named local volumes, via the same
 * accounting `docker system df -v` shows a person. Returns null when the daemon does
 * not answer (not running, or the command otherwise failed), so callers can fall back
 * to "Docker not running" instead of a wrong zero.
 */
export async function dockerVolumeSizes(
  binary: string,
  env: Record<string, string>,
  cwd: string,
  run: RunDocker,
  names: string[],
): Promise<Record<string, number> | null> {
  const result = await run(binary, ["system", "df", "-v", "--format", "json"], {
    cwd,
    env,
    timeoutMs: 15_000,
  });
  if (result.code !== 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  const volumes = (parsed as { Volumes?: unknown }).Volumes;
  if (!Array.isArray(volumes)) return null;
  const wanted = new Set(names);
  const sizes: Record<string, number> = {};
  for (const entry of volumes) {
    if (typeof entry !== "object" || entry === null) continue;
    const name = (entry as { Name?: unknown }).Name;
    const size = (entry as { Size?: unknown }).Size;
    if (typeof name !== "string" || typeof size !== "string" || !wanted.has(name)) continue;
    const bytes = parseDockerSize(size);
    if (bytes !== null) sizes[name] = bytes;
  }
  return sizes;
}
