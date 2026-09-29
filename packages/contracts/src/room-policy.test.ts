import { describe, expect, it } from "vitest";
import { UpdateGroupInput } from "./domain.js";
import {
  applyRoomPolicyPatch,
  parseRoomPolicy,
  ROOM_POLICY_MAX_CONCURRENT_RUNS_MAX,
  ROOM_POLICY_MAX_CONCURRENT_RUNS_MIN,
  ROOM_POLICY_V1_DEFAULTS,
  RoomPolicyPatchSchema,
  RoomPolicyV1Schema,
} from "./room-policy.js";

describe("room policy", () => {
  it("defaults a group room to four bots answering at once", () => {
    expect(ROOM_POLICY_V1_DEFAULTS).toEqual({ version: 1, maxConcurrentRuns: 4 });
    expect(parseRoomPolicy(null)).toEqual(ROOM_POLICY_V1_DEFAULTS);
    expect(parseRoomPolicy(undefined)).toEqual(ROOM_POLICY_V1_DEFAULTS);
  });

  it("accepts the bounds and rejects values outside them", () => {
    expect(
      RoomPolicyV1Schema.parse({
        version: 1,
        maxConcurrentRuns: ROOM_POLICY_MAX_CONCURRENT_RUNS_MIN,
      }).maxConcurrentRuns,
    ).toBe(1);
    expect(
      RoomPolicyV1Schema.parse({
        version: 1,
        maxConcurrentRuns: ROOM_POLICY_MAX_CONCURRENT_RUNS_MAX,
      }).maxConcurrentRuns,
    ).toBe(8);
    for (const bad of [0, 9, 2.5, "4"]) {
      expect(RoomPolicyV1Schema.safeParse({ version: 1, maxConcurrentRuns: bad }).success).toBe(
        false,
      );
    }
  });

  it("reads defaults for a policy from another version", () => {
    expect(RoomPolicyV1Schema.safeParse({ version: 2, maxConcurrentRuns: 4 }).success).toBe(false);
    expect(parseRoomPolicy({ version: 99, maxConcurrentRuns: 1 })).toEqual(ROOM_POLICY_V1_DEFAULTS);
    expect(parseRoomPolicy("not json")).toEqual(ROOM_POLICY_V1_DEFAULTS);
    expect(parseRoomPolicy([{ version: 1, maxConcurrentRuns: 2 }])).toEqual(
      ROOM_POLICY_V1_DEFAULTS,
    );
  });

  it("reads the stored settings it knows and ignores the rest", () => {
    expect(parseRoomPolicy({ version: 1, maxConcurrentRuns: 7 })).toEqual({
      version: 1,
      maxConcurrentRuns: 7,
    });
    // Written by a newer app with a setting this one has not heard of.
    expect(parseRoomPolicy({ version: 1, maxConcurrentRuns: 2, future: true })).toEqual({
      version: 1,
      maxConcurrentRuns: 2,
    });
  });

  it("reads the default for a setting that is missing or no longer valid", () => {
    // Stored before the setting existed.
    expect(parseRoomPolicy({ version: 1 })).toEqual(ROOM_POLICY_V1_DEFAULTS);
    for (const bad of [0, 9, 2.5, "4", null]) {
      expect(parseRoomPolicy({ version: 1, maxConcurrentRuns: bad })).toEqual(
        ROOM_POLICY_V1_DEFAULTS,
      );
    }
  });

  it("changes only the settings a change names", () => {
    expect(applyRoomPolicyPatch(null, { maxConcurrentRuns: 2 })).toEqual({
      version: 1,
      maxConcurrentRuns: 2,
    });
    const stored = { version: 1, maxConcurrentRuns: 6 };
    expect(applyRoomPolicyPatch(stored, {})).toEqual(stored);
    expect(applyRoomPolicyPatch(stored, { maxConcurrentRuns: undefined })).toEqual(stored);
    expect(applyRoomPolicyPatch(stored, { maxConcurrentRuns: 1 })).toEqual({
      version: 1,
      maxConcurrentRuns: 1,
    });
  });

  it("refuses a change with a value out of bounds or a setting it does not know", () => {
    expect(RoomPolicyPatchSchema.safeParse({}).success).toBe(true);
    expect(RoomPolicyPatchSchema.safeParse({ maxConcurrentRuns: 3 }).success).toBe(true);
    for (const bad of [0, 9, 2.5, "4", null]) {
      expect(RoomPolicyPatchSchema.safeParse({ maxConcurrentRuns: bad }).success).toBe(false);
    }
    expect(RoomPolicyPatchSchema.safeParse({ future: true }).success).toBe(false);
    // The version is not a setting: a change cannot rewrite it.
    expect(RoomPolicyPatchSchema.safeParse({ version: 1 }).success).toBe(false);
    expect(() => applyRoomPolicyPatch(null, { maxConcurrentRuns: 9 })).toThrow();
  });

  it("is checked where a group is updated", () => {
    const groupId = "group-1";
    expect(UpdateGroupInput.safeParse({ groupId }).success).toBe(true);
    expect(UpdateGroupInput.safeParse({ groupId, roomPolicy: {} }).success).toBe(true);
    expect(
      UpdateGroupInput.safeParse({ groupId, roomPolicy: { maxConcurrentRuns: 8 } }).success,
    ).toBe(true);
    for (const roomPolicy of [
      { maxConcurrentRuns: 0 },
      { maxConcurrentRuns: 9 },
      { maxConcurrentRuns: 2.5 },
      { other: 1 },
      { version: 1 },
    ]) {
      expect(UpdateGroupInput.safeParse({ groupId, roomPolicy }).success).toBe(false);
    }
  });
});
