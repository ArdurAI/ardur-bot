import { describe, expect, it } from "vitest";
import { COMMAND_TEXT_LIMIT, CommandRequestSchema } from "./command-blocks.js";

describe("command request size", () => {
  it("accepts 40 KB and the exact 64 KB boundary", () => {
    expect(CommandRequestSchema.safeParse({ command: "x".repeat(40 * 1024) }).success).toBe(true);
    expect(
      CommandRequestSchema.safeParse({ command: "x".repeat(COMMAND_TEXT_LIMIT) }).success,
    ).toBe(true);
  });
  it.each(["x".repeat(70 * 1024), "é".repeat(40 * 1024)])(
    "rejects oversized UTF-8 text with a clear reason",
    (command) => {
      const result = CommandRequestSchema.safeParse({ command });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0]?.message).toBe("Command exceeds 64 KB.");
    },
  );
});
