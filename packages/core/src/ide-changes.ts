import type { IdeChange } from "@ardurbot/contracts";
import { CommandBlockSchema, IDE_DIFF_BYTES } from "@ardurbot/contracts";

/** Display only recorded hunks: omitted context is never presented as a complete file. */
export function recordedDiffs(text: string) {
  const files: Array<{ path: string; before: string; after: string }> = [];
  let current: (typeof files)[number] | undefined;
  let oldPath = "";
  let hunk = false;
  if (new TextEncoder().encode(text).length > IDE_DIFF_BYTES) return files;
  for (const line of text.split("\n")) {
    if (line.startsWith("--- ")) {
      oldPath = line.slice(4).split("\t")[0]!.replace(/^a\//, "");
      hunk = false;
    } else if (line.startsWith("+++ ")) {
      const nextPath = line.slice(4).split("\t")[0]!.replace(/^b\//, "");
      current = { path: nextPath === "/dev/null" ? oldPath : nextPath, before: "", after: "" };
      files.push(current);
    } else if (current && /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) {
      current.before += `${line}\n`;
      current.after += `${line}\n`;
      hunk = true;
    } else if (hunk && current) {
      if (line.startsWith("-")) current.before += `${line.slice(1)}\n`;
      else if (line.startsWith("+")) current.after += `${line.slice(1)}\n`;
      else if (line.startsWith(" ")) {
        current.before += `${line.slice(1)}\n`;
        current.after += `${line.slice(1)}\n`;
      } else if (!line.startsWith("\\")) hunk = false;
    }
  }
  return files.filter((file) => file.before || file.after);
}

export function eventFileChanges(event: {
  id: string;
  botId: string;
  runId: string | null;
  createdAt: Date;
  type: string;
  payload: unknown;
}): Array<IdeChange & { computerId: string | null; cwd?: string | null }> {
  const base = {
    id: event.id,
    botId: event.botId,
    runId: event.runId,
    createdAt: event.createdAt.toISOString(),
  };
  if (!event.payload || typeof event.payload !== "object") return [];
  const payload = event.payload as Record<string, unknown>;
  if (
    event.type === "computer.file.changed" &&
    typeof payload.path === "string" &&
    typeof payload.computerId === "string" &&
    (payload.source === "tool" || payload.source === "artifact")
  ) {
    const text = (value: unknown) =>
      typeof value === "string" && new TextEncoder().encode(value).length <= IDE_DIFF_BYTES
        ? value
        : null;
    return [
      {
        ...base,
        computerId: payload.computerId,
        path: payload.path,
        source: payload.source,
        before: text(payload.before),
        after: text(payload.after),
      },
    ];
  }
  if (event.type !== "command.finished") return [];
  const parsed = CommandBlockSchema.safeParse(payload.block);
  if (
    !parsed.success ||
    parsed.data.redacted ||
    parsed.data.truncated ||
    parsed.data.outcome !== "completed"
  )
    return [];
  const command = parsed.data;
  return recordedDiffs(command.stdout ?? "").map((file, index) => ({
    ...base,
    ...file,
    id: `${event.id}-${index}`,
    computerId: command.computerId,
    cwd: command.cwd,
    source: "command",
  }));
}
