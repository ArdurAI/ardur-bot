import { SCOREBOARD_MANIFEST } from "../manifest.js";
import { digest } from "../resources/contracts.js";

export const STARTUP_STRATA = [
  "process-cold-os-warm",
  "chromium-cache-cold",
  "warm-relaunch",
  "fresh-install",
  "local-stack-cold",
  "reboot-cold",
] as const;
export type StartupStratum = (typeof STARTUP_STRATA)[number];
export type ClientSurface = "desktop" | "web" | "mobile";
export interface PackagedTrial {
  pairId: string;
  sessionId: string;
  build: "parent" | "candidate" | "fixed-release";
  stratum: StartupStratum;
  resetId: string;
}

/** Fixed order before collection. Each stratum/build gets independent reset receipts. */
export function createPackagedPlan(options: {
  mode: "commit" | "release";
  samples?: number;
  strata?: readonly StartupStratum[];
}): PackagedTrial[] {
  if (options.mode !== "commit" && options.mode !== "release")
    throw new Error("Unknown sample mode");
  const minimum =
    options.mode === "commit"
      ? SCOREBOARD_MANIFEST.samplePlan.commitPairs
      : SCOREBOARD_MANIFEST.samplePlan.releaseStartupObservationsPerStratum;
  const samples = options.samples ?? minimum;
  if (!Number.isSafeInteger(samples) || samples < minimum || samples > 10_000)
    throw new Error("Insufficient or excessive startup sample plan");
  const strata = options.strata ?? STARTUP_STRATA;
  if (
    !strata.length ||
    new Set(strata).size !== strata.length ||
    strata.some((s) => !STARTUP_STRATA.includes(s))
  )
    throw new Error("Invalid startup strata");
  return strata.flatMap((stratum) =>
    Array.from({ length: samples }, (_, index) => {
      const builds: PackagedTrial["build"][] =
        index % 2
          ? ["candidate", "fixed-release", "parent"]
          : ["parent", "fixed-release", "candidate"];
      return builds.map((build) => ({
        pairId: `${stratum}-${index}`,
        sessionId: `session-${stratum}-${index}`,
        build,
        stratum,
        resetId: `reset-${stratum}-${index}-${build}`,
      }));
    }).flat(),
  );
}

export const RELEASE_TARGETS = [
  "desktop-darwin-arm64",
  "desktop-darwin-x64",
  "desktop-linux-x64",
  "desktop-linux-arm64",
  "desktop-win32-x64",
  "web-chromium",
  "web-firefox",
  "web-webkit",
  "mobile-ios-device",
  "mobile-android-device",
] as const;

/** A client result never grants another platform or energy coverage. Release wiring selects required cells. */
export function packagedCoverage(
  observed: readonly { target: string; artifactHash: string; physicalEnergy: boolean }[],
) {
  if (new Set(observed.map((r) => r.target)).size !== observed.length)
    throw new Error("Duplicate release target");
  for (const result of observed) {
    digest(result.artifactHash);
    if (
      !(RELEASE_TARGETS as readonly string[]).includes(result.target) ||
      typeof result.physicalEnergy !== "boolean"
    )
      throw new Error("Unknown target coverage");
  }
  return RELEASE_TARGETS.map((target) => {
    const result = observed.find((item) => item.target === target);
    return {
      target,
      artifactHash: result?.artifactHash ?? null,
      packaged: result ? "observed" : "not-measured",
      energy: result?.physicalEnergy ? "observed" : "not-measured",
    };
  });
}
