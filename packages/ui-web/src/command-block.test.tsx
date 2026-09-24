import type { CommandBlock as FixtureCommandBlock } from "@ardurbot/core";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CommandBlock } from "./command-block.js";

const labels = {
  copyCommand: "Copy command",
  copyOutput: "Copy output",
  exportRun: "Export run",
  exportBlock: "Export block",
  rerun: "Rerun",
  share: "Copy block link",
  search: "Search run output",
  notRecorded: "Not recorded",
  incomplete: "Completion not recorded",
  copyFailed: "Select the text to copy it.",
};
describe("web command block", () => {
  it("folds output without loading/layout expansion and escapes terminal text", () => {
    const html = renderToString(
      <CommandBlock
        block={commandBlock({ command: "<script>ignored</script>" })}
        labels={labels}
      />,
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("grid-template-rows:0fr");
    expect(html).not.toContain("Tests passed.");
    expect(html).not.toContain("<script>");
    expect(html).toContain("motion-reduce:transition-none");
  });
  it("renders historical gaps and incomplete recordings visibly", () => {
    const html = renderToString(
      <CommandBlock
        block={commandBlock({
          command: null,
          cwd: null,
          durationMs: null,
          exitCode: null,
          startedAt: null,
          outcome: "unknown",
        })}
        labels={labels}
      />,
    );
    expect(html).toContain("Not recorded");
    expect(html).toContain("Completion not recorded");
    expect(html).toMatchSnapshot();
  });
});

function commandBlock(overrides: Partial<FixtureCommandBlock> = {}): FixtureCommandBlock {
  return {
    commandId: "command-1",
    runId: "run-1",
    attemptId: "attempt-1",
    executionId: "execution-1",
    command: "pnpm test",
    cwd: "/workspace",
    computerId: "computer-1",
    computer: "docker:container-1",
    startedAt: "2026-09-23T12:00:00.000Z",
    durationMs: 12000,
    exitCode: 0,
    outcome: "completed",
    stdout: "Tests passed.\n",
    stderr: "",
    error: null,
    redacted: false,
    truncated: false,
    replayOf: null,
    rerunDisabledReason: null,
    ...overrides,
  };
}
