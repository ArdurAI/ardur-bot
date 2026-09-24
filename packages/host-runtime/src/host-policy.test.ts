import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
  it.each([
    { argv: ["/bin/sh", "-c", "echo bad"] },
    { argv: ["node", "-e", "process.exit()"] },
    { argv: ["echo bad; whoami"] },
    { argv: ["echo", "$(whoami)"] },
    { argv: ["echo", "ok"], env: { TOKEN: "never" } },
  ])("refuses arbitrary binary, shell or environment %j", async (request) => {
    await expect(hostCommand(request)).rejects.toThrow("runs only echo, pwd and whoami");
  });
  it("resolves allowed commands to an absolute executable without accepting a binary path", async () => {
    const command = await hostCommand({ argv: ["echo", "ok"] });
    expect(path.isAbsolute(command[0]!)).toBe(true);
    expect(command.slice(1)).toEqual(["ok"]);
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
