import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { COMMAND_OUTPUT_LIMIT, COMMAND_TRUNCATED } from "@ardurbot/core";
import { expect, it } from "vitest";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";

it("bounds native command output at collection and records its actual working directory", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "command-output-")));
  try {
    const sandbox = new DesktopSandboxProvider({ root });
    const context = {
      operationId: "operation-1",
      traceId: "trace-1",
      spaceId: "space-1",
      userId: "user-1",
      signal: new AbortController().signal,
    };
    const computer = await sandbox.provision({ botId: "bot-1", homePath: "unused" }, context);
    const cwd = await sandbox.resolveCommandCwd(computer, "project", context);
    const events = [];
    for await (const event of sandbox.execute(
      computer,
      {
        argv: [
          process.execPath,
          "-e",
          "process.stderr.write(process.cwd()); process.stdout.write('x'.repeat(1024 * 1024))",
        ],
        cwd: "project",
      },
      context,
    ))
      events.push(event);
    const stdout = events.find((event) => event.type === "stdout");
    expect(stdout?.type === "stdout" && stdout.data.length).toBeLessThan(COMMAND_OUTPUT_LIMIT + 40);
    expect(stdout?.type === "stdout" && stdout.data).toContain(COMMAND_TRUNCATED);
    expect(events).toContainEqual({ type: "stderr", data: cwd });
    expect(events).toContainEqual({ type: "exit", code: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
