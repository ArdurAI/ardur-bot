import * as z from "zod";

/** A read-only observation, never configured defaults or host capacity. */
export const ComputerLimitsObservationSchema = z.object({
  observedAt: z.iso.datetime(),
  cpuCores: z.number().positive().finite().nullable(),
  memoryBytes: z.number().int().positive().safe().nullable(),
  processes: z.number().int().positive().safe().nullable(),
});
export type ComputerLimitsObservation = z.infer<typeof ComputerLimitsObservationSchema>;
export const COMPUTER_LIMITS_MAX_AGE_MS = 60_000;

export function currentComputerLimits(
  value: unknown,
  now = Date.now(),
): ComputerLimitsObservation | null {
  const result = ComputerLimitsObservationSchema.safeParse(value);
  if (!result.success) return null;
  const age = now - Date.parse(result.data.observedAt);
  return age >= 0 && age <= COMPUTER_LIMITS_MAX_AGE_MS ? result.data : null;
}
