import type { AdapterContext, ComputerRef, SandboxProvider } from "@ardurbot/adapter-kit";
import { IDE_DIFF_BYTES } from "@ardurbot/contracts";
import { redactSecrets } from "@ardurbot/core";
import type { ThreadEvents } from "@ardurbot/db";
import { getLogger } from "@ardurbot/logging";
import { sensitiveShellCommand } from "./command-recording.js";

export function fileChangeText(bytes: Uint8Array, secrets: string[] = []) {
  if (bytes.length > IDE_DIFF_BYTES || bytes.includes(0)) return null;
  try {
    return redactSecrets(new TextDecoder("utf-8", { fatal: true }).decode(bytes), secrets);
  } catch {
    return null;
  }
}
export async function beforeFileChange(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  path: string,
  context: AdapterContext,
  secrets: string[],
) {
  if (sensitiveShellCommand(path.replaceAll("\\", "/"))) return null;
  try {
    return fileChangeText(
      await sandbox.readFile(computer, path, context, { maxBytes: IDE_DIFF_BYTES }),
      secrets,
    );
  } catch {
    return null;
  }
}
/** A missing or large before-image stays unknown. Audit failure never replays a successful write. */
export async function recordFileChange(
  events: ThreadEvents,
  target: { spaceId: string; threadId: string; botId: string; id: string },
  change: {
    computerId: string;
    path: string;
    source: "tool" | "artifact";
    before: string | null;
    after: string | null;
  },
  secrets: string[],
) {
  try {
    await events.append({
      spaceId: target.spaceId,
      threadId: target.threadId,
      botId: target.botId,
      runId: target.id,
      type: "computer.file.changed",
      payload: {
        ...change,
        ...(sensitiveShellCommand(change.path.replaceAll("\\", "/"))
          ? { before: null, after: null }
          : {}),
        path: redactSecrets(change.path, secrets),
      },
    });
  } catch {
    getLogger().warn("File change could not be recorded.");
  }
}
