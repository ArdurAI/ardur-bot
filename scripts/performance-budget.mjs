import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export function timingWarnings(before, after) {
  if (
    before.kind !== after.kind ||
    JSON.stringify(before.machine) !== JSON.stringify(after.machine)
  ) {
    return [
      "Timing environments differ; collect a comparable baseline before interpreting a regression.",
    ];
  }
  return Object.entries(before.metrics).flatMap(([metric, value]) => {
    const current = after.metrics[metric];
    if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(current))
      return [`Missing or invalid timing: ${metric}.`];
    return current > value * 1.2
      ? [
          `${metric} regressed ${((current / value - 1) * 100).toFixed(1)}%; advisory budget is 20%.`,
        ]
      : [];
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [before, after] = await Promise.all(
    process.argv.slice(2, 4).map(async (file) => JSON.parse(await readFile(file, "utf8"))),
  );
  console.log(JSON.stringify({ before: before.metrics, after: after.metrics }, null, 2));
  for (const warning of timingWarnings(before, after))
    console.warn(`::warning title=Performance budget::${warning}`);
}
