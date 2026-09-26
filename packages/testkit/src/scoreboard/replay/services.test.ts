import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext } from "@ardurbot/adapter-kit";
import { expect, it } from "vitest";
import { getTask } from "../tasks/catalog.js";
import { DepartmentSandbox } from "./services.js";

it("seeds the production team workspace, preserves actual writes and refuses paths outside the computer", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "scoreboard-files-"));
  const context: AdapterContext = {
    botId: "fixture-bot",
    spaceId: "fixture-space",
    userId: "fixture-user",
    operationId: "fixture-operation",
    traceId: "fixture-trace",
    signal: new AbortController().signal,
  };
  try {
    const task = getTask("task-01");
    const sandbox = new DepartmentSandbox(root, task);
    const computer = await sandbox.provision({ botId: "fixture-team", homePath: root }, context);
    expect(
      new TextDecoder().decode(
        await sandbox.readFile(computer, "bots/fixture-bot/policy.json", context),
      ),
    ).toBe(task.files["policy.json"]);
    await sandbox.writeFile(
      computer,
      { path: "bots/fixture-bot/result.json", content: Buffer.from("{}") },
      context,
    );
    expect(await sandbox.snapshotFiles("fixture-team", "fixture-bot")).toEqual({
      files: {
        ...task.files,
        "result.json": "{}",
      },
      links: [],
    });
    await expect(sandbox.readFile(computer, "../grader.ts", context)).rejects.toThrow(
      "outside workspace",
    );
    const events = [];
    for await (const event of sandbox.execute(
      computer,
      { argv: ["sh", "-c", "echo forbidden"] },
      context,
    ))
      events.push(event);
    expect(events).toContainEqual({ type: "exit", code: 126 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
