import { contentDigest } from "../manifest.js";
import type { Reading } from "./contracts.js";
import { digest, exactKeys, finite, measured, opaque, unavailable } from "./contracts.js";

export interface EnergyBinding {
  artifactHash: string;
  environmentHash: string;
  workloadHash: string;
  platform: "darwin" | "linux" | "win32" | "ios" | "android";
  hardwareClass: string;
  conditionsHash: string;
  durationMs: number;
}
export interface PhysicalEnergyCapture {
  version: 1;
  binding: EnergyBinding;
  instrument: {
    id: string;
    method: "joule-counter" | "power-meter";
    scope: "whole-system" | "device" | "cpu-package";
    calibrationHash: string;
    calibratedAt: string;
    validUntil: string;
    uncertaintyPercent: number;
  };
  measuredAt: string;
  physical: true;
  samples: { atMs: number; value: number }[];
  // A separate idle capture with the same hardware, instrument, conditions and duration.
  idleControlHash: string | null;
}
export interface EnergySampler {
  start(binding: EnergyBinding, signal: AbortSignal): Promise<void>;
  stop(): Promise<
    PhysicalEnergyCapture | { missingReason: "unsupported" | "infrastructure-unavailable" }
  >;
}

function timestamp(value: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value)
    throw new Error("Invalid energy timestamp");
  return parsed;
}

/** Physical ingestion is deliberately independent of Electron battery/thermal metadata. */
export function ingestPhysicalEnergy(
  capture: PhysicalEnergyCapture,
  expected: EnergyBinding,
  idle: PhysicalEnergyCapture,
) {
  if (idle.idleControlHash !== null || capture.idleControlHash !== contentDigest(idle))
    throw new Error("Idle control bytes do not match their digest");
  const result = readPhysicalEnergy(capture, expected);
  const control = readPhysicalEnergy(idle, idle.binding);
  if (
    idle.binding.platform !== expected.platform ||
    idle.binding.hardwareClass !== expected.hardwareClass ||
    idle.binding.conditionsHash !== expected.conditionsHash ||
    idle.binding.durationMs !== expected.durationMs ||
    idle.instrument.id !== capture.instrument.id ||
    idle.instrument.calibrationHash !== capture.instrument.calibrationHash ||
    idle.instrument.scope !== capture.instrument.scope ||
    idle.instrument.method !== capture.instrument.method
  )
    throw new Error("Unmatched idle energy control");
  return { ...result, idleJoules: control.joules, idleControlHash: capture.idleControlHash };
}

function readPhysicalEnergy(capture: PhysicalEnergyCapture, expected: EnergyBinding) {
  exactKeys(capture, [
    "version",
    "binding",
    "instrument",
    "measuredAt",
    "physical",
    "samples",
    "idleControlHash",
  ]);
  exactKeys(capture.binding, [
    "artifactHash",
    "environmentHash",
    "workloadHash",
    "platform",
    "hardwareClass",
    "conditionsHash",
    "durationMs",
  ]);
  exactKeys(capture.instrument, [
    "id",
    "method",
    "scope",
    "calibrationHash",
    "calibratedAt",
    "validUntil",
    "uncertaintyPercent",
  ]);
  if (capture.version !== 1 || capture.physical !== true)
    throw new Error("Physical energy capture required");
  for (const field of [
    "artifactHash",
    "environmentHash",
    "workloadHash",
    "conditionsHash",
  ] as const) {
    digest(capture.binding[field]);
    if (capture.binding[field] !== expected[field])
      throw new Error("Energy capture binding mismatch");
  }
  if (
    !["darwin", "linux", "win32", "ios", "android"].includes(capture.binding.platform) ||
    capture.binding.platform !== expected.platform ||
    capture.binding.hardwareClass !== expected.hardwareClass ||
    capture.binding.durationMs !== expected.durationMs
  )
    throw new Error("Energy target or duration mismatch");
  opaque(capture.binding.hardwareClass);
  opaque(capture.instrument.id);
  digest(capture.instrument.calibrationHash);
  finite(capture.instrument.uncertaintyPercent);
  if (capture.instrument.uncertaintyPercent > 100)
    throw new Error("Invalid calibration uncertainty");
  const when = timestamp(capture.measuredAt);
  if (
    timestamp(capture.instrument.calibratedAt) > when ||
    timestamp(capture.instrument.validUntil) < when + expected.durationMs
  )
    throw new Error("Expired energy calibration");
  if (
    !["joule-counter", "power-meter"].includes(capture.instrument.method) ||
    !["whole-system", "device", "cpu-package"].includes(capture.instrument.scope)
  )
    throw new Error("CPU time and battery state are not energy instruments");
  if (capture.idleControlHash !== null) digest(capture.idleControlHash);
  finite(expected.durationMs);
  if (
    expected.durationMs === 0 ||
    capture.samples.length < 2 ||
    capture.samples.length > 100_000 ||
    capture.samples[0]!.atMs !== 0 ||
    capture.samples.at(-1)!.atMs !== expected.durationMs
  )
    throw new Error("Incomplete energy window");
  let joules = 0;
  for (let i = 0; i < capture.samples.length; i++) {
    const sample = capture.samples[i]!;
    exactKeys(sample, ["atMs", "value"]);
    finite(sample.atMs);
    finite(sample.value);
    const previous = capture.samples[i - 1];
    if (!previous) continue;
    if (sample.atMs <= previous.atMs) throw new Error("Duplicate or reversed energy samples");
    if (capture.instrument.method === "joule-counter") {
      if (sample.value < previous.value)
        throw new Error("Energy counter reset or wrap requires a new capture");
      joules += sample.value - previous.value;
    } else {
      // Trapezoidal integration of instrument watts, never CPU percent or battery state.
      if (sample.atMs - previous.atMs > 1000)
        throw new Error("Power sample gap exceeds one second");
      joules += (((sample.value + previous.value) / 2) * (sample.atMs - previous.atMs)) / 1000;
    }
  }
  const systemCoverage = capture.instrument.scope !== "cpu-package";
  return {
    joules: measured(joules),
    averageWatts: measured(joules / (expected.durationMs / 1000)),
    systemEnergy: systemCoverage ? measured(joules) : unavailable("unsupported"),
    scope: capture.instrument.scope,
    uncertaintyPercent: capture.instrument.uncertaintyPercent,
    idleControlHash: capture.idleControlHash,
  };
}

export function missingEnergy(reason: "unsupported" | "infrastructure-unavailable"): {
  joules: Reading;
  averageWatts: Reading;
} {
  return { joules: unavailable(reason), averageWatts: unavailable(reason) };
}
