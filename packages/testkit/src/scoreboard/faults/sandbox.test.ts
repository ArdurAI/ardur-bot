import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { FaultSandbox } from "./sandbox.js";

it("retains real files across adapter restart and refuses host commands", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "matrix-sandbox-"));
  try {
    const context = {
      spaceId: "fixture",
      userId: "fixture",
      botId: "fixture",
      operationId: "fixture",
      traceId: "fixture",
      signal: new AbortController().signal,
    };
    const first = new FaultSandbox(directory);
    const computer = await first.provision({ botId: "fixture", homePath: directory }, context);
    await first.writeFile(computer, {
      path: "retained.txt",
      content: Buffer.from("Synthetic durable content"),
    });
    const restarted = new FaultSandbox(directory);
    expect(Buffer.from(await restarted.readFile(computer, "retained.txt")).toString()).toBe(
      "Synthetic durable content",
    );
    const events = [];
    for await (const event of restarted.execute(computer, { argv: ["echo", "refused"] }, context))
      events.push(event);
    expect(events.at(-1)).toEqual({ type: "exit", code: 126 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
