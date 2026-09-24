import { execFileSync } from "node:child_process";
import { symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AdapterContext, PortableFile } from "@ardurbot/adapter-kit";
import { SshSettingsSchema } from "@ardurbot/contracts";
import { expect, it } from "vitest";
import { readFleetArchive, writeFleetArchive } from "./archive.js";
import { remoteArgv } from "./process.js";
import { SshSandboxProvider, sshOptions } from "./ssh-sandbox.js";
import { fakeSshTransport } from "./test-process.js";

const context: AdapterContext = {
  operationId: "test",
  traceId: "test",
  userId: "owner",
  spaceId: "space",
  signal: new AbortController().signal,
};
it("quotes all remote argv once and rejects option/host injection", () => {
  const values = [
    "a'b",
    "$(printf injected)",
    "`printf injected`",
    "a;echo injected",
    "line\nbreak",
    "",
    " spaces ",
  ];
  const printed = execFileSync(
    "bash",
    [
      "-c",
      remoteArgv(["python3", "-c", "import sys,json; print(json.dumps(sys.argv[1:]))", ...values]),
    ],
    { encoding: "utf8" },
  );
  expect(JSON.parse(printed)).toEqual(values);
  expect(() => remoteArgv(["bad\0value"])).toThrow();
  for (const host of ["-oProxyCommand=bad", "host;bad", "host\nsecond", "$(bad)"])
    expect(SshSettingsSchema.safeParse({ host, user: "runner" }).success).toBe(false);
  const settings = SshSettingsSchema.parse({ host: "computer.invalid", user: "runner" });
  expect(sshOptions(settings)).toEqual(
    expect.arrayContaining([
      "BatchMode=yes",
      "StrictHostKeyChecking=yes",
      "ForwardAgent=no",
      "none",
    ]),
  );
  expect(() => sshOptions({ ...settings, authentication: "private-key" })).toThrow("SSH key");
});

it("round trips executable and binary checkpoints, confines paths, and keeps a home across sleep", async () => {
  const fake = await fakeSshTransport();
  const provider = new SshSandboxProvider(
    SshSettingsSchema.parse({ host: "computer.invalid", user: "runner", baseDirectory: fake.root }),
    fake.processes,
  );
  try {
    const computer = await provider.provision({ botId: "bot", homePath: "" }, context);
    await provider.prepare(computer, context);
    expect(provider.describe().capabilities).toMatchObject({
      pty: true,
      interactiveTerminal: true,
      graphical: false,
      persistentHome: true,
    });
    const file = {
      path: "nested/tool",
      content: Uint8Array.from([0, 255, 1, 128]),
      executable: true,
    };
    await provider.writeFile(computer, file, context);
    expect(await provider.readFile(computer, file.path, context)).toEqual(file.content);
    expect(await provider.listFiles(computer, "nested", context)).toEqual([
      { path: file.path, kind: "file", size: 4, executable: true },
    ]);
    for (const escapedPath of [
      "../escape",
      "/etc/passwd",
      "nested/../../escape",
      ".ardurbot-runtime/secret",
    ])
      await expect(
        provider.writeFile(computer, { ...file, path: escapedPath }, context),
      ).rejects.toThrow();
    await symlink(fake.root, path.join(await provider.root(computer, context), "escape"));
    await expect(provider.readFile(computer, "escape/outside", context)).rejects.toThrow();
    await expect(
      provider.writeFile(computer, { ...file, path: "escape/outside" }, context),
    ).rejects.toThrow();
    const checkpoint: PortableFile[] = [];
    for await (const entry of provider.exportWorkspace(computer, context)) checkpoint.push(entry);
    expect(checkpoint).toEqual([file]);
    await provider.stop(computer, context);
    expect(await provider.provision({ botId: "bot", homePath: "" }, context)).toMatchObject({
      fresh: false,
    });
    await provider.destroy(computer, context);
    const restored = await provider.provision({ botId: "bot", homePath: "" }, context);
    expect(restored.fresh).toBe(true);
    await provider.importWorkspace(
      restored,
      (async function* () {
        yield* checkpoint;
      })(),
      context,
    );
    expect(await provider.readFile(restored, file.path, context)).toEqual(file.content);
    expect(fake.calls.some((call) => call.name === "sftp")).toBe(true);
    await expect(provider.root({ ...restored, botId: "another" }, context)).rejects.toThrow(
      "belong",
    );
  } finally {
    await fake.close();
  }
});

it("executes with a confined working directory, real quoting and a pty", async () => {
  const fake = await fakeSshTransport();
  const provider = new SshSandboxProvider(
    SshSettingsSchema.parse({ host: "computer.invalid", user: "runner", baseDirectory: fake.root }),
    fake.processes,
  );
  try {
    const computer = await provider.provision({ botId: "bot", homePath: "" }, context);
    const events = [];
    for await (const event of provider.execute(
      computer,
      { argv: ["bash", "-c", "test -t 1 && printf '%s' \"$HOME\""], pty: true, timeoutMs: 3000 },
      context,
    ))
      events.push(event);
    expect(events).toContainEqual({ type: "exit", code: 0 });
    expect(
      events
        .filter((event) => event.type === "stdout")
        .map((event) => ("data" in event ? event.data : ""))
        .join(""),
    ).toBe(await provider.root(computer, context));
    await expect(provider.resolveCommandCwd(computer, "../escape", context)).rejects.toThrow();
  } finally {
    await fake.close();
  }
});

it("refuses symlinked homes and tampered checkpoints", async () => {
  const fake = await fakeSshTransport();
  try {
    await writeFile(path.join(fake.root, "sentinel"), "safe");
    await symlink(fake.root, path.join(fake.root, "alias"));
    const provider = new SshSandboxProvider(
      SshSettingsSchema.parse({
        host: "computer.invalid",
        user: "runner",
        baseDirectory: path.join(fake.root, "alias"),
      }),
      fake.processes,
    );
    await expect(provider.provision({ botId: "bot", homePath: "" }, context)).rejects.toThrow();
    const archive = await writeFleetArchive(
      (async function* () {
        yield { path: "safe", content: Buffer.from("ok") };
      })(),
    );
    archive[0] = 0;
    expect(() => [...readFleetArchive(archive)]).toThrow();
    await expect(
      writeFleetArchive(
        (async function* () {
          yield { path: "../escape", content: Buffer.alloc(0) };
        })(),
      ),
    ).rejects.toThrow();
  } finally {
    await fake.close();
  }
});
