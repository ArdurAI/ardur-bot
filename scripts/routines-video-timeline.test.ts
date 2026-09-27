import { describe, expect, it } from "vitest";
import { buildTimeline, vttTime } from "../site/scripts/routines-video-timeline";

describe("routine video timeline", () => {
  const shots = [5, 6, 9, 9, 5, 6, 9, 7].map((seconds, index, all) => {
    const startMs = all.slice(0, index).reduce((sum, value) => sum + value * 1_000 + 500, 0);
    return { id: index + 1, startMs, endMs: startMs + seconds * 1_000 + 500 };
  });

  it("places every caption on the exported 56-second timeline", () => {
    const seventh = shots[6]!;
    const timeline = buildTimeline({
      recordingStartEpochMs: 1_000,
      shots: [
        ...shots.slice(0, 6),
        { ...seventh, endMs: seventh.endMs + 4_000 },
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
