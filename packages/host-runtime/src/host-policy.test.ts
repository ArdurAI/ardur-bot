import { chmod, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandRequest } from "@ardurbot/adapter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { confinedHostCwd, hostCommand } from "./host-policy.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "host-policy-"));
  cleanup.push(root);
  await mkdir(path.join(root, "allowed"));
  await mkdir(path.join(root, "outside"));
  return root;
}
const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "space",
  userId: "owner",
  botId: "bot",
  runId: "run",
  signal: new AbortController().signal,
};

describe("host process confinement", () => {
  it("rejects symlink escape, dot-dot, and outside-root cwd", async () => {
    const root = await fixture(),
      allowed = path.join(root, "allowed"),
      outside = path.join(root, "outside");
    await symlink(outside, path.join(allowed, "escape"));
    await expect(confinedHostCwd(path.join(allowed, "escape"), [allowed])).rejects.toThrow();
    await expect(confinedHostCwd(`${allowed}/../allowed`, [allowed])).rejects.toThrow();
    await expect(confinedHostCwd(outside, [allowed])).rejects.toThrow();
    expect(await confinedHostCwd(allowed, [allowed])).toBe(
      allowed.replace(/^\/var\//, "/private/var/"),
    );
    const provider = new DesktopSandboxProvider({ root, hostRoots: [allowed], restricted: true });
    const computer = await provider.provision({ botId: "bot", homePath: "ignored" }, context);
    for (const cwd of [path.join(allowed, "escape"), `${allowed}/../allowed`, outside]) {
      await expect(
        collect(provider.execute(computer, { argv: ["echo", "never"], cwd }, context)),
      ).rejects.toThrow();
    }
  });
  it.each<CommandRequest>([
    { argv: ["/bin/sh", "-c", "echo bad"] },
    { argv: ["../bin/gh"] },
    { argv: ["C:\\Tools\\gh.exe"] },
    { argv: ["echo", "ok"], env: { TOKEN: "never" } },
    { argv: ["echo", "ok"], env: {} },
    { argv: ["echo", "ok"], pty: true },
    { argv: ["echo", "\0"] },
    { argv: [] },
  ])("refuses caller executable paths, environment and terminal overrides %j", async (request) => {
    await expect(hostCommand(request, { PATH: "/fixture/bin" })).rejects.toThrow(
      "Command did not run",
    );
  });
  it("resolves allowed commands to an absolute executable without accepting a binary path", async () => {
    const root = await fixture();
    for (const name of ["gh", "bash"]) {
      await writeFile(path.join(root, name), "fixture");
      await chmod(path.join(root, name), 0o700);
    }
    const env = { PATH: root };
    expect(await hostCommand({ argv: ["gh", "auth", "status"] }, env)).toEqual([
      await realpath(path.join(root, "gh")),
      "auth",
      "status",
    ]);
    const script = "which gh && gh auth status 2>&1 | head -5\nprintf '%s' \"$HOME\"";
    expect(await hostCommand({ argv: ["bash", "-c", script] }, env)).toEqual([
      await realpath(path.join(root, "bash")),
      "-c",
      script,
    ]);
    await expect(hostCommand({ argv: [path.join(root, "gh")] }, env)).rejects.toThrow(
      "not an executable path",
    );
    await expect(hostCommand({ argv: ["missing"] }, env)).rejects.toThrow("not found");
  });
  it("refuses a replaced provisioning parent before creating outside directories", async () => {
    const root = await fixture();
    await symlink(path.join(root, "outside"), path.join(root, "desktop-computers"));
    const provider = new DesktopSandboxProvider({ root, restricted: true });
    await expect(provider.provision({ botId: "bot", homePath: "" }, context)).rejects.toThrow(
      "escapes",
    );
    expect(await readdir(path.join(root, "outside"))).toEqual([]);
  });
  it("bounds file reads and prepares directories relative to the confined cwd", async () => {
    const root = await fixture(),
      allowed = path.join(root, "allowed");
    const provider = new DesktopSandboxProvider({ root, hostRoots: [allowed], restricted: true });
    const computer = await provider.provision({ botId: "bot", homePath: "" }, context);
    await writeFile(path.join(computer.providerRef, "large.txt"), "0123456789");
    await expect(
      provider.readFile(computer, "large.txt", context, { maxBytes: 9 }),
    ).rejects.toThrow("too large");
    await expect(
      provider.readFile(computer, "large.txt", context, { maxBytes: 10 }),
    ).resolves.toEqual(new Uint8Array(Buffer.from("0123456789")));
    expect(
      await collect(
        provider.execute(
          computer,
          { argv: ["mkdir", "-p", "nested/folder"], cwd: allowed },
          context,
        ),
      ),
    ).toEqual([{ type: "exit", code: 0 }]);
    expect(await readdir(path.join(allowed, "nested"))).toEqual(["folder"]);
  });
});

async function collect<T>(source: AsyncIterable<T>) {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}
