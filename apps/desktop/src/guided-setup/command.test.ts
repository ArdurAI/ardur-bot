import { describe, expect, it } from "vitest";
import type { CommandBoundary, CommandFile } from "./command.js";
import { ArdurCommandInstaller } from "./command.js";

function fixture() {
  const entries = new Map<string, CommandFile>();
  let resolved: string | null = null;
  let version = "1.0";
  let interruptLink = false;
  const files: CommandBoundary = {
    inspect: async (file) => entries.get(file) ?? { kind: "missing" },
    resolveOnPath: async () => resolved,
    version: async () => version,
    ensure: async () => undefined,
    link: async (target, file) => {
      if (entries.has(file)) throw new Error("name already exists");
      entries.set(file, { kind: "link", target });
      if (interruptLink) throw new Error("interrupted after link");
    },
  };
  const installer = new ArdurCommandInstaller("/fixture/app/ardur", "1.0", "/fixture/data", files);
  return {
    installer,
    entries,
    setResolved: (value: string | null) => {
      resolved = value;
    },
    setVersion: (value: string) => {
      version = value;
    },
    interrupt: () => {
      interruptLink = true;
    },
  };
}

describe("ArdurCommandInstaller", () => {
  it("reuses a matching package-managed command", async () => {
    const f = fixture();
    f.entries.set("/fixture/bin/ardur", { kind: "link", target: "/fixture/app/ardur" });
    f.setResolved("/fixture/bin/ardur");
    expect(await f.installer.check()).toBe("ready");
    expect(await f.installer.install()).toEqual({ kind: "reused", proof: "matching-command" });
    expect(f.entries.size).toBe(1);
  });

  it("refuses a foreign PATH command and a foreign owned name", async () => {
    const f = fixture();
    f.entries.set("/fixture/bin/ardur", { kind: "file", target: "/other/app" });
    f.setResolved("/fixture/bin/ardur");
    expect(await f.installer.check()).toBe("collision");
    await expect(f.installer.install()).rejects.toThrow("command-collision");
    f.setResolved(null);
    f.entries.set(f.installer.ownedPath, { kind: "link", target: "/other/app" });
    expect(await f.installer.check()).toBe("collision");
  });

  it("refuses a changed resolved target even when its version text matches", async () => {
    const f = fixture();
    f.entries.set("/fixture/app/ardur", { kind: "file", identity: "/fixture/app/ardur" });
    f.entries.set("/fixture/bin/ardur", {
      kind: "link",
      target: "/fixture/app/ardur",
      identity: "/other/app",
    });
    f.setResolved("/fixture/bin/ardur");
    expect(await f.installer.check()).toBe("collision");
  });

  it("keeps a matching owned link waiting until PATH resolves the same executable", async () => {
    const f = fixture();
    expect(await f.installer.check()).toBe("needed");
    expect(await f.installer.install()).toEqual({ kind: "owned", proof: "owned-link" });
    expect(await f.installer.check()).toBe("waiting-path");
    f.setResolved(f.installer.ownedPath);
    f.setVersion("0.9");
    expect(await f.installer.check()).toBe("collision");
    f.setVersion("1.0");
    expect(await f.installer.check()).toBe("ready");
  });

  it("recovers a final link left by an interruption without overwriting it", async () => {
    const f = fixture();
    f.interrupt();
    await expect(f.installer.install()).rejects.toThrow("interrupted after link");
    expect(await f.installer.check()).toBe("waiting-path");
    await expect(f.installer.reconcile()).resolves.toBeUndefined();
    expect(f.entries.get(f.installer.ownedPath)).toEqual({
      kind: "link",
      target: "/fixture/app/ardur",
    });
  });
});
