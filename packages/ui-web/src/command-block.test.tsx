// @vitest-environment jsdom
import type { CommandBlock as FixtureCommandBlock } from "@ardurbot/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
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
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  it("shows the command line in monospace without markdown backticks", () => {
    const html = renderToString(
      <CommandBlock
        block={commandBlock({ command: "cat planning/release-checklist.md" })}
        labels={labels}
      />,
    );
    expect(html).toContain("Ran cat planning/release-checklist.md in /workspace");
    expect(html).not.toContain("`");
    expect(html).toContain("font-mono");
  });
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
  it("renders human-readable time as visible text while keeping the ISO value in dateTime", () => {
    const html = renderToString(
      <CommandBlock
        block={commandBlock({ startedAt: "2026-09-23T12:00:00.000Z" })}
        labels={labels}
      />,
    );
    expect(html).toContain('dateTime="2026-09-23T12:00:00.000Z"');
    expect(html).not.toContain(">2026-09-23T12:00:00.000Z<");
  });
  it("falls back to notRecorded label without throwing when startedAt is unparseable", () => {
    const html = renderToString(
      <CommandBlock block={commandBlock({ startedAt: "not-a-valid-date" })} labels={labels} />,
    );
    expect(html).toContain('dateTime="not-a-valid-date"');
    expect(html).toContain("Not recorded");
    expect(html).not.toContain("not-a-valid-date</time>");
  });
  it("renders German locale format when prop locale is de-DE even if navigator.language is en-US", () => {
    const originalLanguage = navigator.language;
    try {
      Object.defineProperty(navigator, "language", {
        value: "en-US",
        configurable: true,
      });
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 8, 27, 10, 0));
      const html = renderToString(
        <CommandBlock
          block={commandBlock({ startedAt: new Date(2026, 8, 24, 14, 30).toISOString() })}
          labels={labels}
          locale="de-DE"
        />,
      );
      expect(html).toContain("24. Sept.");
      expect(html).not.toContain("Sep 24");
    } finally {
      vi.useRealTimers();
      Object.defineProperty(navigator, "language", {
        value: originalLanguage,
        configurable: true,
      });
    }
  });
  it("updates today rendering across midnight and clears the timer on unmount", async () => {
    vi.useFakeTimers();
    const initialTime = new Date(2026, 8, 24, 23, 59, 30);
    vi.setSystemTime(initialTime);

    const startedAt = new Date(2026, 8, 24, 23, 50, 0).toISOString();
    const host = document.createElement("div");
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(
          <CommandBlock block={commandBlock({ startedAt })} labels={labels} locale="en-US" />,
        );
      });

      expect(host.textContent).not.toContain("Sep 24");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(40_000);
      });

      expect(host.textContent).toContain("Sep 24");
    } finally {
      await act(async () => {
        root.unmount();
      });
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    }
  });
  it("renders absolute date and time in title attribute on time element", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 27, 10, 0));
    try {
      const html = renderToString(
        <CommandBlock
          block={commandBlock({ startedAt: new Date(2026, 8, 24, 14, 30).toISOString() })}
          labels={labels}
          locale="en-US"
        />,
      );
      expect(html).toContain('title="Sep 24, 2026');
    } finally {
      vi.useRealTimers();
    }
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
