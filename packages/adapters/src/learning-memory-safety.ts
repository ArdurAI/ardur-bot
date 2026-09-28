import { redactLearningText } from "@ardurbot/core";
import { redactSensitiveText } from "@ardurbot/logging";
import { assertMemorySafe, MemoryRedactionError } from "@ardurbot/memory";

/** Check original content and return only a detector-verified safe line in errors. */
export function assertSafeMemoryContent(
  content: string,
  knownSecrets: readonly string[],
  proposalId?: string,
): void {
  try {
    assertMemorySafe(content, knownSecrets);
    return;
  } catch (error) {
    if (!(error instanceof MemoryRedactionError)) throw error;
  }
  const lines = content.split(/\r\n|\n|\r/u);
  const index = lines.findIndex((line) => {
    try {
      assertMemorySafe(line, knownSecrets);
      return false;
    } catch (error) {
      if (!(error instanceof MemoryRedactionError)) throw error;
      return true;
    }
  });
  const line = lines[Math.max(index, 0)] ?? "";
  const masked = redactSensitiveText(redactLearningText(line, knownSecrets));
  let safe = masked !== line;
  if (safe) {
    try {
      assertMemorySafe(masked, knownSecrets);
    } catch (error) {
      if (!(error instanceof MemoryRedactionError)) throw error;
      safe = false;
    }
  }
  throw new MemoryRedactionError(
    proposalId,
    Math.max(index, 0) + 1,
    safe ? masked.slice(0, 300) : "contains something that looks like a credential",
  );
}
