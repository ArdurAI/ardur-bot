import type { CommandBlock } from "@ardurbot/contracts";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { createRoot } from "react-dom/client";
import { ThreadCommandBlock } from "../../src/components/ThreadCommandBlock";
import "../../src/styles.css";

const i18n = setupI18n({ locale: "en", messages: { en: {} } });
const block: CommandBlock = {
  commandId: "command-1",
  runId: "run-1",
  attemptId: "attempt-1",
  executionId: "execution-1",
  command: "pnpm test",
  cwd: "~/work",
  computerId: "computer-1",
  computer: "docker:example-container",
  startedAt: "2026-09-23T12:00:00.000Z",
  durationMs: 12000,
  exitCode: 0,
  outcome: "completed",
  stdout: "Tests passed.\n<script>window.commandExecuted = true</script>",
  stderr: "A test was skipped.\n",
  error: null,
  redacted: false,
  truncated: false,
  replayOf: null,
  rerunDisabledReason: null,
};

createRoot(document.getElementById("root")!).render(
  <I18nProvider i18n={i18n}>
    <main className="min-h-screen bg-background p-8 text-foreground">
      <div className="mx-auto max-w-3xl space-y-4">
        <ThreadCommandBlock block={block} spaceId="space-1" />
        <ThreadCommandBlock
          block={{
            ...block,
            commandId: "old-command",
            command: null,
            cwd: null,
            startedAt: null,
            durationMs: null,
            exitCode: null,
            stdout: null,
            stderr: null,
            computer: null,
            outcome: "unknown",
            rerunDisabledReason: "The original command was not recorded.",
          }}
          spaceId="space-1"
        />
      </div>
    </main>
  </I18nProvider>,
);
