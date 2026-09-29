import { z } from "zod";

/** Versioned room policy stored on a chat group. Defaults live here, nowhere else. */
export const RoomPolicyV1Schema = z.strictObject({
  version: z.literal(1),
  /** How many bots may hold an active run in the room's thread at once. */
  maxConcurrentRuns: z.number().int().min(1).max(8),
});
export type RoomPolicyV1 = z.infer<typeof RoomPolicyV1Schema>;

export const ROOM_POLICY_MAX_CONCURRENT_RUNS_MIN = 1;
export const ROOM_POLICY_MAX_CONCURRENT_RUNS_MAX = 8;

/** A group room answers with up to four bots at once unless the owner narrows it. */
export const ROOM_POLICY_V1_DEFAULTS: RoomPolicyV1 = {
  version: 1,
  maxConcurrentRuns: 4,
};

/** A room without a stored policy (or with one from a newer app) reads the defaults. */
export function parseRoomPolicy(raw: unknown): RoomPolicyV1 {
  if (raw === null || raw === undefined) return ROOM_POLICY_V1_DEFAULTS;
  const parsed = RoomPolicyV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : ROOM_POLICY_V1_DEFAULTS;
}
