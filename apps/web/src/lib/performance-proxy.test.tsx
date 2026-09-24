import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { ProductEvent, ThreadSnapshot } from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ShellSkeleton } from "../components/ShellSkeleton";
import { applyThreadSendReceipt, reduceThreadSnapshot } from "./thread-events";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

const createdAt = "2026-09-23T00:00:00.000Z";
const initial: ThreadSnapshot = {
  botId: "fixture-bot",
  threadId: "fixture-thread",
  cursor: 100,
  olderCursor: null,
  run: null,
  messages: Array.from({ length: 100 }, (_, seq) => ({
    id: `message-${seq}`,
    threadId: "fixture-thread",
    seq,
    role: "bot",
    blocks: [{ kind: "text", text: "Fixture message" }],
    createdAt,
  })),
};
async function* fakeProvider(): AsyncGenerator<ProductEvent> {
  await Promise.resolve();
  yield {
    id: "first-token",
    spaceId: "fixture-space",
    botId: "fixture-bot",
    threadId: "fixture-thread",
    runId: "fixture-run",
    seq: 101,
    type: "thread.progress",
    createdAt,
    payload: { text: "Hello" },
  };
}
function median(values: number[]) {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
}

it("measures shell preparation and submit-to-first-token reduction with an offline provider", async () => {
  const shell: number[] = [];
  const token: number[] = [];
  for (let index = 0; index < 220; index++) {
    const shellStart = performance.now();
    const html = renderToString(<ShellSkeleton />);
    const shellMs = performance.now() - shellStart;
    expect(html).toContain('data-ardurbot-app-state="session-pending"');
    const sendStart = performance.now();
    let snapshot = applyThreadSendReceipt(initial, {
      botId: "fixture-bot",
      runId: "fixture-run",
      taskId: "fixture-task",
      createdAt,
    });
    for await (const event of fakeProvider()) {
      snapshot = reduceThreadSnapshot(snapshot, event);
      break;
    }
    const tokenMs = performance.now() - sendStart;
    expect(snapshot?.messages.at(-1)?.blocks).toEqual([{ kind: "progress", text: "Hello" }]);
    // Warm the test harness; these are unit proxies, not browser paint timings.
    if (index >= 20) {
      shell.push(shellMs);
      token.push(tokenMs);
    }
  }
  const report = {
    kind: "offline-proxy",
    date: new Date().toISOString().slice(0, 10),
    machine: {
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model,
      cores: os.cpus().length,
      memoryGiB: os.totalmem() / 2 ** 30,
      node: process.version,
    },
    samples: shell.length,
    metrics: { shellPrepareMs: median(shell), submitToFirstTokenMs: median(token) },
  };
  console.log(JSON.stringify(report));
  if (process.env.PERF_REPORT_FILE) {
    await mkdir(path.dirname(process.env.PERF_REPORT_FILE), { recursive: true });
    await writeFile(process.env.PERF_REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
  }
});
