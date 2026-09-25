import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { redactMatrixDiagnostic } from "./redact.js";

describe("matrix diagnostic redaction", () => {
  it("redacts runner, temp, file and database locations and leaves ordinary errors", () => {
    const linux =
      "Error: ENOENT /home/runner/work/ardur-bot/ardur-bot/packages/testkit/src/cli/scoreboard-matrix.ts";
    const macTemp = "open /var/folders/ab/xyz/T/matrix-fault-1 and /private/tmp/matrix-fault-2";
    const fileUrl = "loaded file:///tmp/matrix-fault-3/identity.json";
    const database = "connect postgresql://fixture:secret@127.0.0.1:5433/scoreboard_trial_1";
    expect(redactMatrixDiagnostic(linux)).toBe("Error: ENOENT <redacted>");
    expect(redactMatrixDiagnostic(macTemp)).toBe("open <redacted> and <redacted>");
    expect(redactMatrixDiagnostic(fileUrl)).toBe("loaded <redacted>");
    expect(redactMatrixDiagnostic(database)).toBe("connect <redacted>");
    expect(redactMatrixDiagnostic("/Users/someone/data /Volumes/data/cache")).toBe(
      "<redacted> <redacted>",
    );
    expect(redactMatrixDiagnostic("Declared crash boundary was not reached")).toBe(
      "Declared crash boundary was not reached",
    );
    expect(redactMatrixDiagnostic("the private grant was revoked")).toBe(
      "the private grant was revoked",
    );
  });
  it("is the only copy of the matrix path redaction", () => {
    for (const file of [
      "../cli/scoreboard-matrix.ts",
      "./faults/process.ts",
      "./faults/worker.ts",
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).toContain("redactMatrixDiagnostic");
      expect(source).not.toMatch(/postgres\\S\+/);
    }
  });
});
