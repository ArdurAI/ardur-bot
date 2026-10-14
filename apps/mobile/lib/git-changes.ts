import type { GitChangeKind, GitStatusEntry } from "@ardurbot/contracts";

/** Matches the credential redaction marker. A diff that contains it is not shown. */
export const GIT_DIFF_REDACTION_MARKER = "[Redacted]";

export const GIT_CHANGE_ORDER = [
  "added",
  "modified",
  "deleted",
  "untracked",
] as const satisfies readonly GitChangeKind[];

export function gitEntryChange(entry: GitStatusEntry): GitChangeKind {
  return entry.change ?? (entry.untracked ? "untracked" : "modified");
}

export function gitDiffWithheld(diff: { before: string | null; after: string | null }): boolean {
  return (
    (diff.before?.includes(GIT_DIFF_REDACTION_MARKER) ?? false) ||
    (diff.after?.includes(GIT_DIFF_REDACTION_MARKER) ?? false)
  );
}

export type TextDiffLine = { kind: "added" | "removed" | "context"; text: string };

function splitLines(value: string | null): string[] {
  if (value === null || value === "") return [];
  return value.split("\n");
}

/** Line diff for a bounded text pair. Prefixes, not color, mark added and removed lines. */
export function textDiffLines(before: string | null, after: string | null): TextDiffLine[] {
  if (before === null) return splitLines(after).map((text) => ({ kind: "added", text }));
  if (after === null) return splitLines(before).map((text) => ({ kind: "removed", text }));
  return diffLines(splitLines(before), splitLines(after));
}

function diffLines(before: string[], after: string[]): TextDiffLine[] {
  const n = before.length;
  const m = after.length;
  if (n * m > 1_000_000) return indexDiff(before, after);
  const scores: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = scores[i]!;
    const next = scores[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = before[i] === after[j] ? next[j + 1]! + 1 : Math.max(next[j]!, scores[i]![j + 1]!);
    }
  }
  const lines: TextDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      lines.push({ kind: "context", text: before[i]! });
      i++;
      j++;
    } else if (scores[i + 1]![j]! >= scores[i]![j + 1]!) {
      lines.push({ kind: "removed", text: before[i]! });
      i++;
    } else {
      lines.push({ kind: "added", text: after[j]! });
      j++;
    }
  }
  while (i < n) lines.push({ kind: "removed", text: before[i++]! });
  while (j < m) lines.push({ kind: "added", text: after[j++]! });
  return lines;
}

function indexDiff(before: string[], after: string[]): TextDiffLine[] {
  const rows = Math.max(before.length, after.length);
  const lines: TextDiffLine[] = [];
  for (let index = 0; index < rows; index++) {
    const oldLine = before[index];
    const newLine = after[index];
    if (oldLine === newLine && oldLine !== undefined)
      lines.push({ kind: "context", text: oldLine });
    else {
      if (oldLine !== undefined) lines.push({ kind: "removed", text: oldLine });
      if (newLine !== undefined) lines.push({ kind: "added", text: newLine });
    }
  }
  return lines;
}

export function diffLinePrefix(kind: TextDiffLine["kind"]): string {
  if (kind === "added") return "+ ";
  if (kind === "removed") return "- ";
  return "  ";
}
