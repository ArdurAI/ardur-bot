import { describe, expect, it } from "vitest";
import {
  parseRoomPolicy,
  ROOM_POLICY_MAX_CONCURRENT_RUNS_MAX,
  ROOM_POLICY_MAX_CONCURRENT_RUNS_MIN,
  ROOM_POLICY_V1_DEFAULTS,
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
      RoomPolicyV1Schema.parse({ version: 1, maxConcurrentRuns: ROOM_POLICY_MAX_CONCURRENT_RUNS_MIN })
        .maxConcurrentRuns,
    ).toBe(1);
    expect(
      RoomPolicyV1Schema.parse({ version: 1, maxConcurrentRuns: ROOM_POLICY_MAX_CONCURRENT_RUNS_MAX })
        .maxConcurrentRuns,
    ).toBe(8);
    for (const bad of [0, 9, 2.5, "4"]) {
      expect(
        RoomPolicyV1Schema.safeParse({ version: 1, maxConcurrentRuns: bad }).success,
      ).toBe(false);
    }
  });

  it("rejects unknown versions and extra keys so later fields get their own version", () => {
    expect(RoomPolicyV1Schema.safeParse({ version: 2, maxConcurrentRuns: 4 }).success).toBe(false);
    expect(
      RoomPolicyV1Schema.safeParse({ version: 1, maxConcurrentRuns: 4, future: true }).success,
    ).toBe(false);
  });

  it("reads defaults for a stored value the running app cannot parse", () => {
    expect(parseRoomPolicy({ version: 99, maxConcurrentRuns: 1 })).toEqual(ROOM_POLICY_V1_DEFAULTS);
    expect(parseRoomPolicy("not json")).toEqual(ROOM_POLICY_V1_DEFAULTS);
    expect(parseRoomPolicy({ version: 1, maxConcurrentRuns: 7 })).toEqual({
      version: 1,
      maxConcurrentRuns: 7,
    });
  });
});
