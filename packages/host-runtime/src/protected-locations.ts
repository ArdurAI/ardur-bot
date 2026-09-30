import { isAbsolute, join, normalize, sep } from "node:path";
import type { ProcessLocationKind, ProtectedLocation } from "@ardurbot/contracts";
import { deniedLocationIds, PROTECTED_LOCATIONS_DEFAULTS } from "@ardurbot/contracts";
import {
  type HostGuardrailConfig,
  resolveGuardrailPathsSync,
  resolveRealPathSync,
} from "./host-guardrails.js";

/**
 * Protected locations as absolute host paths.
 *
 * The contracts hold the table (packages/contracts/src/protected-locations.ts);
 * this module turns it into what the host enforces: the absolute paths a process
 * is kept out of, ready for the Seatbelt profile and the in-process file tools.
 * `~/` becomes the owner's home, and each path contributes its real path and its
 * spelled path, as resolveGuardrailPathsSync does, so a location reached through
 * a link is denied at its target too. Nothing here stores grants or starts
 * processes — that is step 1b.
 */

/**
 * The absolute paths a process is kept out of, from the table's rules. A path that
 * leaves the home folder after resolving `..` is refused rather than denied.
 */
export function protectedPaths(input: {
  process: ProcessLocationKind;
  tool?: string;
  grants: string[];
  locations?: ProtectedLocation[];
  home: string;
}): string[] {
  const locations = input.locations ?? PROTECTED_LOCATIONS_DEFAULTS;
  const denied = new Set(
    deniedLocationIds({
      process: input.process,
      tool: input.tool,
      grants: input.grants,
      locations,
    }),
  );
  const paths: string[] = [];
  for (const location of locations) {
    if (!denied.has(location.id)) continue;
    for (const entry of location.paths)
      paths.push(...resolveGuardrailPathsSync([homePath(entry, input.home)]));
  }
  return [...new Set(paths)];
}

/**
 * `~/name` becomes `<home>/name`. The entry must stay inside `home` once `..` is
 * resolved, so a table entry cannot reach outside the owner's home.
 */
function homePath(entry: string, home: string): string {
  if (!entry.startsWith("~/"))
    throw new Error(`A protected location path is written from the home folder: ${entry}`);
  const absolute = join(home, entry.slice(2));
  const normalized = normalize(absolute);
  const base = normalize(home);
  if (normalized === base || !normalized.startsWith(base.endsWith(sep) ? base : base + sep))
    throw new Error(`A protected location path leaves the home folder: ${entry}`);
  return absolute;
}

/** The machine's guard plus those paths, without changing the guard it was given. */
export function withProtectedLocations(
  guard: HostGuardrailConfig,
  paths: string[],
): HostGuardrailConfig {
  return {
    paths: [...new Set([...guard.paths, ...paths])],
    ports: [...guard.ports],
    sockets: [...guard.sockets],
  };
}

/**
 * The location a path belongs to, or undefined. A path inside a location's folder
 * (or equal to its file) belongs to it; the target is resolved first, so a location
 * reached through a link is found at its target. Case-insensitive where the
 * platform folds case. Used for the hint below and by the in-process file tools.
 */
export function protectedLocationOf(
  target: string,
  locations: ProtectedLocation[] = PROTECTED_LOCATIONS_DEFAULTS,
  home: string,
  platform: NodeJS.Platform = process.platform,
): ProtectedLocation | undefined {
  const real = resolveRealPathSync(target);
  for (const location of locations) {
    for (const entry of location.paths) {
      const base = homePath(entry, home);
      // Both spellings of the location's folder are checked: as written and as the
      // disk spells it, so a home reached through a link still matches its target.
      if (
        isInside(real, base, platform) ||
        isInside(real, resolveRealPathSync(base), platform) ||
        isInside(target, base, platform)
      )
        return location;
    }
  }
  return undefined;
}

function isInside(target: string, base: string, platform: NodeJS.Platform): boolean {
  const fold = platform === "darwin" || platform === "win32";
  const left = fold ? target.toLowerCase() : target;
  const right = fold ? base.toLowerCase() : base;
  return left === right || left.startsWith(right.endsWith(sep) ? right : right + sep);
}

/**
 * One plain line for command output that says an operation is not permitted and
 * names a path inside a protected location: the location's label and where the
 * owner grants access. Decided from the path, never from the wording alone, so a
 * failure that mentions no protected path gets no hint.
 */
export function protectedLocationHint(
  output: string,
  locations: ProtectedLocation[] = PROTECTED_LOCATIONS_DEFAULTS,
  home: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  for (const token of output.match(/[^\s"'`]+/g) ?? []) {
    const candidate = token.replace(/^[("'`]+|[)"'`.,;:]+$/g, "");
    if (!candidate.includes(sep)) continue;
    const absolute = candidate.startsWith("~")
      ? expandTilde(candidate, home)
      : isAbsolute(candidate)
        ? candidate
        : undefined;
    if (!absolute) continue;
    const location = protectedLocationOf(absolute, locations, home, platform);
    if (location)
      return `${location.label} is protected on this computer. The owner can grant this bot access in the bot's settings.`;
  }
  return undefined;
}

function expandTilde(candidate: string, home: string): string | undefined {
  if (candidate === "~") return home;
  if (candidate.startsWith("~/")) return join(home, candidate.slice(2));
  return undefined;
}
