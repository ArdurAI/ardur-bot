import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Shot = { id: number; startMs: number; endMs: number; actionEndMs?: number };
type Sidecar = {
  recordingStartEpochMs: number;
  shots: Shot[];
  processingCut: { startMs: number; endMs: number };
};

const durations = [5, 6, 9, 9, 5, 6, 9, 7] as const;
const captions = [
  "Give recurring work a routine.",
  "Name the work.",
  "Write what the bot should do.\nThis example uses sample notes.",
  "Choose a schedule.\nWeekdays at 8:00 AM · UTC",
  "Save the routine.",
  "Test the saved instruction now.",
  "Read the result. Check Run history.\nProcessing time shortened",
  "Ardur · Routines\nGive recurring work a routine.\nKeep your home services running.",
] as const;

export function vttTime(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);
  const millis = Math.round(ms % 1_000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

export function buildTimeline(sidecar: Sidecar) {
  if (sidecar.shots.length !== 8 || !Number.isFinite(sidecar.recordingStartEpochMs))
    throw new Error("Recording sidecar must contain eight shots and a recording start time.");
  const cut = sidecar.processingCut;
  const segments: { startMs: number; durationMs: number }[] = [];
  const shotDurationsMs: number[] = [];
  let previousEnd = -1;
  for (const [index, shot] of sidecar.shots.entries()) {
    const wantedMs = durations[index]! * 1_000;
    if (
      shot.id !== index + 1 ||
      !Number.isFinite(shot.startMs) ||
      !Number.isFinite(shot.endMs) ||
      shot.startMs < previousEnd ||
      shot.endMs <= shot.startMs
    )
      throw new Error(`Shot ${index + 1} has invalid or overlapping offsets.`);
    previousEnd = shot.endMs;
    if (shot.id === 7) {
      if (
        !Number.isFinite(cut.startMs) ||
        !Number.isFinite(cut.endMs) ||
        cut.startMs < shot.startMs ||
        cut.endMs <= cut.startMs ||
        cut.endMs >= shot.endMs
      )
        throw new Error("Shot 7 needs a processing cut within its offsets.");
      const beforeMs = cut.startMs - shot.startMs;
      const afterMs = wantedMs - beforeMs;
      const recordedAfterMs = shot.endMs - cut.endMs;
      if (beforeMs > wantedMs || recordedAfterMs < afterMs)
        throw new Error("Shot 7 has too little footage around the processing cut.");
      if (beforeMs > 0) segments.push({ startMs: shot.startMs, durationMs: beforeMs });
      const afterOverBudget =
        shot.actionEndMs !== undefined
          ? shot.actionEndMs > cut.endMs + afterMs
          : recordedAfterMs > afterMs;
      const afterDurationMs = afterOverBudget ? recordedAfterMs : afterMs;
      segments.push({ startMs: cut.endMs, durationMs: afterDurationMs });
      shotDurationsMs.push((beforeMs > 0 ? beforeMs : 0) + afterDurationMs);
    } else {
      const recordedMs = shot.endMs - shot.startMs;
      if (recordedMs < wantedMs)
        throw new Error(`Shot ${shot.id} is shorter than ${durations[index]} seconds.`);
      const overBudget =
        shot.actionEndMs !== undefined
          ? shot.actionEndMs > shot.startMs + wantedMs
          : recordedMs > wantedMs;
      const durationMs = overBudget ? recordedMs : wantedMs;
      segments.push({ startMs: shot.startMs, durationMs });
      shotDurationsMs.push(durationMs);
    }
  }
  let cueStart = 0;
  const vtt = [
    "WEBVTT",
    "",
    ...shotDurationsMs.flatMap((durationMs, index) => {
      const start = cueStart;
      cueStart += durationMs;
      return [`${vttTime(start)} --> ${vttTime(cueStart)}`, captions[index]!, ""];
    }),
  ].join("\n");
  const durationSeconds = cueStart / 1_000;
  return { segments, vtt, durationSeconds };
}

export function filterGraph(
  segments: ReturnType<typeof buildTimeline>["segments"],
  width = 1920,
  height = 1080,
): string {
  const clips = segments.map(
    (segment, index) =>
      `[0:v]trim=start=${segment.startMs / 1_000}:duration=${segment.durationMs / 1_000},setpts=PTS-STARTPTS,fps=30,scale=${width}:${height}:flags=lanczos,format=yuv420p[v${index}]`,
  );
  clips.push(
    `${segments.map((_, index) => `[v${index}]`).join("")}concat=n=${segments.length}:v=1:a=0[base]`,
    "[base]split=2[mp4][webm]",
  );
  return clips.join(";\n");
}

async function main() {
  const [sidecarPath, graphPath, captionsPath, size] = process.argv.slice(2);
  if (!sidecarPath || !graphPath || !captionsPath)
    throw new Error("Usage: routines-video-timeline.ts <shots.json> <filter.txt> <captions.vtt>");
  const sidecar = JSON.parse(await readFile(sidecarPath, "utf8")) as Sidecar;
  const timeline = buildTimeline(sidecar);
  const match = size?.match(/^([1-9]\d*)x([1-9]\d*)$/);
  if (size && !match) throw new Error("Frame size must be WIDTHxHEIGHT.");
  await writeFile(captionsPath, timeline.vtt);
  await writeFile(
    graphPath,
    filterGraph(timeline.segments, Number(match?.[1] ?? 1920), Number(match?.[2] ?? 1080)),
  );
  console.log(
    `Timeline: ${timeline.durationSeconds} seconds, ${timeline.segments.length} segments.`,
  );
  timeline.segments.forEach((segment, index) => {
    console.log(
      `  Segment ${index + 1}: ${(segment.durationMs / 1_000).toFixed(3)}s (${(segment.startMs / 1_000).toFixed(3)}s -> ${((segment.startMs + segment.durationMs) / 1_000).toFixed(3)}s)`,
    );
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
