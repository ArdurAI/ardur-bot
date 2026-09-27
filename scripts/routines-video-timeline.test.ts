import { describe, expect, it } from "vitest";
import { buildTimeline, vttTime } from "../site/scripts/routines-video-timeline";

describe("routine video timeline", () => {
  const shots = [5, 6, 9, 9, 5, 6, 9, 7].map((seconds, index, all) => {
    const startMs = all.slice(0, index).reduce((sum, value) => sum + value * 1_000 + 500, 0);
    return {
      id: index + 1,
      startMs,
      endMs: startMs + seconds * 1_000 + 500,
      actionEndMs: startMs + seconds * 1_000,
    };
  });

  it("places every caption on the exported 56-second timeline", () => {
    const seventh = shots[6]!;
    const timeline = buildTimeline({
      recordingStartEpochMs: 1_000,
      shots: [
        ...shots.slice(0, 6),
        {
          ...seventh,
          endMs: seventh.endMs + 4_000,
          actionEndMs: seventh.startMs + 4_000 + 9_000,
        },
        { ...shots[7]!, startMs: shots[7]!.startMs + 4_000, endMs: shots[7]!.endMs + 4_000 },
      ],
      processingCut: { startMs: seventh.startMs, endMs: seventh.startMs + 4_000 },
    });
    expect(timeline.durationSeconds).toBe(56);
    expect(timeline.vtt).toContain("00:00:40.000 --> 00:00:49.000");
    expect(timeline.vtt).toContain("Processing time shortened");
    expect(timeline.vtt).toContain("00:00:49.000 --> 00:00:56.000");
    expect(timeline.segments[6]).toEqual({ startMs: seventh.startMs + 4_000, durationMs: 9_000 });
    expect(vttTime(3_661_001)).toBe("01:01:01.001");
  });

  it("a normal shot is unchanged", () => {
    const seventh = shots[6]!;
    const timeline = buildTimeline({
      recordingStartEpochMs: 1_000,
      shots: [
        ...shots.slice(0, 6),
        {
          ...seventh,
          endMs: seventh.endMs + 4_000,
          actionEndMs: seventh.startMs + 4_000 + 9_000,
        },
        { ...shots[7]!, startMs: shots[7]!.startMs + 4_000, endMs: shots[7]!.endMs + 4_000 },
      ],
      processingCut: { startMs: seventh.startMs, endMs: seventh.startMs + 4_000 },
    });
    // First shot budget is 5,000 ms; despite having 5,500 ms footage, it exports 5,000 ms.
    expect(timeline.segments[0]).toEqual({ startMs: shots[0]!.startMs, durationMs: 5_000 });
    expect(timeline.durationSeconds).toBe(56);
  });

  it("an over-budget ordinary shot keeps its full footage and shifts later cues", () => {
    const overBudgetShot1 = {
      ...shots[0]!,
      endMs: shots[0]!.startMs + 7_500,
      actionEndMs: shots[0]!.startMs + 7_000,
    };
    const shift = 2_500;
    const shiftedShots = shots.map((shot, idx) => {
      if (idx === 0) return overBudgetShot1;
      return {
        ...shot,
        startMs: shot.startMs + shift,
        endMs: shot.endMs + shift,
        ...(shot.actionEndMs !== undefined ? { actionEndMs: shot.actionEndMs + shift } : {}),
      };
    });
    const shiftedSeventh = shiftedShots[6]!;
    const timeline = buildTimeline({
      recordingStartEpochMs: 1_000,
      shots: [
        ...shiftedShots.slice(0, 6),
        {
          ...shiftedSeventh,
          endMs: shiftedSeventh.endMs + 4_000,
          actionEndMs: shiftedSeventh.startMs + 4_000 + 9_000,
        },
        {
          ...shiftedShots[7]!,
          startMs: shiftedShots[7]!.startMs + 4_000,
          endMs: shiftedShots[7]!.endMs + 4_000,
        },
      ],
      processingCut: { startMs: shiftedSeventh.startMs, endMs: shiftedSeventh.startMs + 4_000 },
    });

    // Over-budget shot 1 keeps its full 7,500 ms footage.
    expect(timeline.segments[0]).toEqual({ startMs: overBudgetShot1.startMs, durationMs: 7_500 });
    // First cue ends at 7.5s instead of 5s.
    expect(timeline.vtt).toContain("00:00:00.000 --> 00:00:07.500");
    // Later cue is shifted by 2.5s (shot 2 now starts at 7.5s and ends at 13.5s).
    expect(timeline.vtt).toContain("00:00:07.500 --> 00:00:13.500");
    // Total duration is 56 + 2.5 = 58.5s.
    expect(timeline.durationSeconds).toBe(58.5);

    // Also verify when actionEndMs is absent, endMs > wantedMs keeps the full footage.
    const noActionEndOverBudget = { id: 1, startMs: 0, endMs: 7_000 };
    const noActionEndShots = [
      noActionEndOverBudget,
      ...shots.slice(1).map((s) => ({
        id: s.id,
        startMs: s.startMs + 2_000,
        endMs: s.startMs + 2_000 + [6, 9, 9, 5, 6, 9, 7][s.id - 2]! * 1_000,
      })),
    ];
    const noActionSeventh = noActionEndShots[6]!;
    const fallbackTimeline = buildTimeline({
      recordingStartEpochMs: 1_000,
      shots: [
        ...noActionEndShots.slice(0, 6),
        { ...noActionSeventh, endMs: noActionSeventh.endMs + 2_000 },
        {
          ...noActionEndShots[7]!,
          startMs: noActionEndShots[7]!.startMs + 2_000,
          endMs: noActionEndShots[7]!.endMs + 2_000,
        },
      ],
      processingCut: { startMs: noActionSeventh.startMs, endMs: noActionSeventh.startMs + 2_000 },
    });
    expect(fallbackTimeline.segments[0]).toEqual({ startMs: 0, durationMs: 7_000 });
  });

  it("shot 7 with the cut still works", () => {
    const seventh = shots[6]!;
    // Normal shot 7
    const normalTimeline = buildTimeline({
      recordingStartEpochMs: 1_000,
      shots: [
        ...shots.slice(0, 6),
        {
          ...seventh,
          endMs: seventh.endMs + 4_000,
          actionEndMs: seventh.startMs + 4_000 + 9_000,
        },
        { ...shots[7]!, startMs: shots[7]!.startMs + 4_000, endMs: shots[7]!.endMs + 4_000 },
      ],
      processingCut: { startMs: seventh.startMs, endMs: seventh.startMs + 4_000 },
    });
    expect(normalTimeline.segments[6]).toEqual({
      startMs: seventh.startMs + 4_000,
      durationMs: 9_000,
    });

    // Over-budget shot 7 after the cut: action resolves late at +11,000 ms, footage is 11,500 ms
    const overBudgetSeventhTimeline = buildTimeline({
      recordingStartEpochMs: 1_000,
      shots: [
        ...shots.slice(0, 6),
        {
          ...seventh,
          endMs: seventh.startMs + 4_000 + 11_500,
          actionEndMs: seventh.startMs + 4_000 + 11_000,
        },
        {
          ...shots[7]!,
          startMs: seventh.startMs + 4_000 + 11_500,
          endMs: seventh.startMs + 4_000 + 11_500 + 7_500,
        },
      ],
      processingCut: { startMs: seventh.startMs, endMs: seventh.startMs + 4_000 },
    });
    // Keeps whole footage after cut (11,500 ms)
    expect(overBudgetSeventhTimeline.segments[6]).toEqual({
      startMs: seventh.startMs + 4_000,
      durationMs: 11_500,
    });
  });

  it("total duration equals the sum of segments", () => {
    const seventh = shots[6]!;
    const timeline = buildTimeline({
      recordingStartEpochMs: 1_000,
      shots: [
        ...shots.slice(0, 6),
        {
          ...seventh,
          endMs: seventh.endMs + 4_000,
          actionEndMs: seventh.startMs + 4_000 + 9_000,
        },
        { ...shots[7]!, startMs: shots[7]!.startMs + 4_000, endMs: shots[7]!.endMs + 4_000 },
      ],
      processingCut: { startMs: seventh.startMs, endMs: seventh.startMs + 4_000 },
    });
    const segmentSum = timeline.segments.reduce((sum, s) => sum + s.durationMs, 0) / 1_000;
    expect(timeline.durationSeconds).toBe(segmentSum);
  });

  it("rejects footage too short to survive the processing cut", () => {
    expect(() =>
      buildTimeline({
        recordingStartEpochMs: 1_000,
        shots,
        processingCut: { startMs: shots[6]!.startMs, endMs: shots[6]!.endMs - 100 },
      }),
    ).toThrow("too little footage");
  });
});
