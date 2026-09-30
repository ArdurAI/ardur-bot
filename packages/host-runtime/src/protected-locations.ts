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
      for (const resolved of resolveGuardrailPathsSync([homePath(entry, input.home)]))
        if (!tooBroad(resolved, input.home)) paths.push(resolved);
  }
  return [...new Set(paths)];
}

/**
 * A location can be a link, and a link can point anywhere. Its target is denied too,
 * unless that target is the home folder, a folder above it, or the root of the disk:
 * denying one of those would keep every command out of everything. The link itself stays
 * denied. `broadProtectedLocations` names such locations so a screen can say so.
 */
function tooBroad(resolved: string, home: string): boolean {
  const homes = resolveGuardrailPathsSync([home]);
  return homes.some((base) => isInside(base, resolved, process.platform));
}

/** The ids of locations whose target is too broad to deny (see `protectedPaths`). */
export function broadProtectedLocations(input: {
  locations?: ProtectedLocation[];
  home: string;
}): string[] {
  const locations = input.locations ?? PROTECTED_LOCATIONS_DEFAULTS;
  return locations
    .filter((location) =>
      location.paths.some((entry) =>
        resolveGuardrailPathsSync([homePath(entry, input.home)]).some((resolved) =>
          tooBroad(resolved, input.home),
        ),
      ),
    )
    .map((location) => location.id);
}

/**
 * `~/name` becomes `<home>/name`. The entry must stay inside `home` once `..` is
 * resolved, so a table entry cannot reach outside the owner's home.
 */
function homePath(entry: string, home: string): string {
  if (!entry.startsWith("~/"))
    throw new Error(`A protected location path is written from the home folder: ${entry}`);
  // Compared and returned without a separator at the end: `normalize` keeps one, and
  // `<home>/` would pass for a place inside the home folder.
  const normalized = withoutTrailingSeparator(normalize(join(home, entry.slice(2))));
  const base = withoutTrailingSeparator(normalize(home));
  if (normalized === base || !normalized.startsWith(base + sep))
    throw new Error(`A protected location path leaves the home folder: ${entry}`);
  return normalized;
}

function withoutTrailingSeparator(value: string): string {
  let end = value.length;
  while (end > 1 && value[end - 1] === sep) end -= 1;
  return value.slice(0, end);
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

/** How a refused read or write reads in a command's output, whatever the tool. */
const REFUSED = /operation not permitted|permission denied|\bEPERM\b|\bEACCES\b/i;

/**
 * One plain line for a command that failed, whose output says an operation was refused
 * and names a path inside a protected location: the location's label and where the owner
 * grants access. It takes all three: a command that succeeded gets no hint, output that
 * only mentions such a path gets none, and a refusal that names no protected path gets
 * none either. Pass the locations the process is kept out of.
 *
 * The output is the bot's own, so the hint is advice to the bot and never evidence: a
 * command can print any line it likes. Access is granted by the owner in settings, which
 * show what the bot is kept out of whatever a command has printed.
 */
export function protectedLocationHint(
  output: string,
  locations: ProtectedLocation[] = PROTECTED_LOCATIONS_DEFAULTS,
  home: string,
  platform: NodeJS.Platform = process.platform,
  exitCode?: number,
): string | undefined {
  if (exitCode === 0) return undefined;
  if (!REFUSED.test(output)) return undefined;
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
