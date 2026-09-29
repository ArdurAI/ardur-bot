import { z } from "zod";

export const ROOM_POLICY_MAX_CONCURRENT_RUNS_MIN = 1;
export const ROOM_POLICY_MAX_CONCURRENT_RUNS_MAX = 8;

/**
 * A room's settings and the values each one accepts. To add a setting, add it here and
 * give it a default in ROOM_POLICY_V1_DEFAULTS: reading, saving and changing it follow.
 */
const roomSettings = {
  /** How many bots may hold an active run in the room's thread at once. */
  maxConcurrentRuns: z
    .number()
    .int()
    .min(ROOM_POLICY_MAX_CONCURRENT_RUNS_MIN)
    .max(ROOM_POLICY_MAX_CONCURRENT_RUNS_MAX),
};

/**
 * Versioned room policy stored on a chat group. The version changes only when a
 * setting changes meaning; a new setting keeps the version and gets a default.
 */
export const RoomPolicyV1Schema = z.object({ version: z.literal(1), ...roomSettings });
export type RoomPolicyV1 = z.infer<typeof RoomPolicyV1Schema>;

/** Defaults live here, nowhere else. A group room answers with up to four bots at once. */
export const ROOM_POLICY_V1_DEFAULTS: RoomPolicyV1 = {
  version: 1,
  maxConcurrentRuns: 4,
};

/** A change to a room's policy: any of its settings. A setting it does not know is refused. */
export const RoomPolicyPatchSchema = z.strictObject(roomSettings).partial();
export type RoomPolicyPatch = z.infer<typeof RoomPolicyPatchSchema>;

/**
 * The policy a room runs under. Each setting is read on its own: one that is missing
 * (stored before the setting existed) or no longer valid reads its default and the rest
 * keep their stored values. A policy from another version reads the defaults.
 */
export function parseRoomPolicy(raw: unknown): RoomPolicyV1 {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return ROOM_POLICY_V1_DEFAULTS;
  }
  const stored = raw as Record<string, unknown>;
  if (stored.version !== ROOM_POLICY_V1_DEFAULTS.version) return ROOM_POLICY_V1_DEFAULTS;
  const policy: Record<string, unknown> = { ...ROOM_POLICY_V1_DEFAULTS };
  for (const [name, setting] of Object.entries(roomSettings)) {
    const parsed = setting.safeParse(stored[name]);
    if (parsed.success) policy[name] = parsed.data;
  }
  return RoomPolicyV1Schema.parse(policy);
}

/** The stored policy with a change applied. Settings the change leaves out keep their value. */
export function applyRoomPolicyPatch(stored: unknown, patch: RoomPolicyPatch): RoomPolicyV1 {
  const changed = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  );
  return RoomPolicyV1Schema.parse({ ...parseRoomPolicy(stored), ...changed });
}
