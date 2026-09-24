/** Reverse only the changed span. Ambiguous or overlapping edits need human review. */
export function inverseLearningChange(
  before: string,
  applied: string,
  current: string,
): string | null {
  if (applied === current) return before;
  const oldLines = before.split("\n");
  const newLines = applied.split("\n");
  const head = current.split("\n");
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start])
    start++;
  let end = 0;
  while (
    end < oldLines.length - start &&
    end < newLines.length - start &&
    oldLines.at(-1 - end) === newLines.at(-1 - end)
  )
    end++;
  const removed = newLines.slice(start, newLines.length - end);
  const replacement = oldLines.slice(start, oldLines.length - end);
  // Include unchanged neighbours so an insertion/deletion cannot match an unrelated span.
  const left = start > 0 ? [newLines[start - 1]!] : [];
  const right = end > 0 ? [newLines[newLines.length - end]!] : [];
  const needle = [...left, ...removed, ...right];
  if (!needle.length) return null;
  const haystack = `\n${current}\n`;
  const pattern = `\n${needle.join("\n")}\n`;
  const match = haystack.indexOf(pattern);
  if (match < 0 || haystack.indexOf(pattern, match + 1) >= 0) return null;
  const line = current.slice(0, match).split("\n").length - 1;
  head.splice(line + left.length, removed.length, ...replacement);
  return head.join("\n");
}
