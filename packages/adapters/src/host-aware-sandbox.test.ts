import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ComputerRef, SandboxProvider } from "@ardurbot/adapter-kit";
import type { PrismaClient } from "@ardurbot/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ComputerBrowserProvider } from "./computer-browser.js";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { DockerSandboxProvider } from "./docker-sandbox.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { createRunSandbox, HostAwareSandbox, sandboxKindForBot } from "./host-aware-sandbox.js";

vi.mock("@ardurbot/host-runtime/host-environment", async (original) => ({
  ...(await original<object>()),
  getHostEnvironment: async () => ({ env: { PATH: process.env.PATH } }),
}));
const ctx = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

describe("host-aware sandbox", () => {
  const hostRoot = mkdtempSync(path.join(tmpdir(), "ardurbot-host-root-"));

  afterAll(() => {
    rmSync(hostRoot, { recursive: true, force: true });
  });

  afterEach(() => vi.restoreAllMocks());

  it.each(["desktop", "daytona"] as const)(
    "forwards history cwd options to the %s provider and preserves execution defaults",
    async (kind) => {
      const isolated = new FakeSandboxProvider();
      const host = new FakeSandboxProvider();
      const isolatedCwd = vi.spyOn(isolated, "resolveCommandCwd");
      const hostCwd = vi.spyOn(host, "resolveCommandCwd");
      const sandbox = new HostAwareSandbox(isolated, host, async () => false);
      const computer: ComputerRef = { id: "computer", providerRef: "ref", botId: "bot", kind };
      const routed = kind === "desktop" ? hostCwd : isolatedCwd;
      await expect(
        sandbox.resolveCommandCwd(computer, undefined, ctx, { activate: false }),
      ).resolves.toBe("/home/ardurbot");
      expect(routed).toHaveBeenLastCalledWith(computer, undefined, ctx, { activate: false });
      await sandbox.resolveCommandCwd(computer, "project", ctx);
      expect(routed).toHaveBeenLastCalledWith(computer, "project", ctx);
      expect(kind === "desktop" ? isolatedCwd : hostCwd).not.toHaveBeenCalled();
    },
  );

  it("exposes and routes page commands through the production Docker wrapper", async () => {
    const result = {
      ok: true,
      url: "https://example.test",
      title: "Page",
      tree: "Page",
      elements: [],
    };
    const pageBrowser = vi
      .spyOn(DockerSandboxProvider.prototype, "pageBrowser")
      .mockResolvedValue(result);
    const sandbox = createRunSandbox("docker", {
      prisma: { deploymentSettings: { findUnique: vi.fn() } } as unknown as PrismaClient,
    });
    const browser = new ComputerBrowserProvider({ sandbox });
    const computer: ComputerRef = {
      id: "computer",
      providerRef: "computer",
      botId: "home",
      kind: "docker",
    };
    expect(browser.describe().capabilities.page).toBe(true);
    expect(await browser.snapshot(computer, {}, ctx)).toMatchObject({
      title: "Page",
      tree: "Page",
    });
    expect(pageBrowser).toHaveBeenCalledWith(computer, { command: "snapshot" }, ctx);

    pageBrowser.mockClear();
    const hostResult = await browser.snapshot({ ...computer, kind: "desktop" }, {}, ctx);
    expect(hostResult.fallback).toBe("computer_act");
    expect(pageBrowser).not.toHaveBeenCalled();
  });

  it("does not expose page commands when neither provider supports them", () => {
    const sandbox = new HostAwareSandbox(
      new FakeSandboxProvider(),
      new DesktopSandboxProvider(),
      async () => false,
    );
    expect(sandbox.pageBrowser).toBeUndefined();
  });

  it("lets this-mac cwd run under a host root", async () => {
    const desktop = new DesktopSandboxProvider({ hostRoots: [hostRoot] });
    const computer = await desktop.provision({ botId: "host", homePath: "/tmp/host-home" }, ctx);
    let code = 1;
    for await (const event of desktop.execute(
      computer,
      { argv: ["echo", "ok"], cwd: hostRoot },
      ctx,
    )) {
      if (event.type === "exit") code = event.code;
    }
    expect(code).toBe(0);
    await desktop.destroy(computer, ctx);
  });

  it("still refuses paths outside home and host roots", async () => {
    const desktop = new DesktopSandboxProvider({ hostRoots: [hostRoot] });
    const computer = await desktop.provision({ botId: "deny", homePath: "/tmp/deny" }, ctx);
    let stderr = "";
    let code = 0;
    for await (const event of desktop.execute(
      computer,
      { argv: ["echo", "nope"], cwd: "/etc" },
      ctx,
    )) {
      if (event.type === "stderr") stderr += event.data;
      if (event.type === "exit") code = event.code;
    }
    expect(code).toBe(1);
    expect(stderr).toMatch(/outside this computer's home/i);
    await desktop.destroy(computer, ctx);
  });

  it("provisions on the host provider when enabled", async () => {
    const isolated = new FakeSandboxProvider();
    const host = new DesktopSandboxProvider();
    const sandbox = new HostAwareSandbox(isolated, host, async () => true);
    const computer = await sandbox.provision({ botId: "switch", homePath: "/tmp/switch" }, ctx);
    expect(computer.kind).toBe("desktop");
    await sandbox.destroy(computer, ctx);
  });

  it("provisions on the isolated provider when this-mac is off", async () => {
    const isolated = new FakeSandboxProvider();
    const host = new DesktopSandboxProvider();
    const sandbox = new HostAwareSandbox(isolated, host, async () => false);
    const computer = await sandbox.provision({ botId: "iso", homePath: "/tmp/iso" }, ctx);
    expect(computer.kind).toBe("fake");
    await sandbox.destroy(computer, ctx);
  });

  it.each([
    ["desktop", false, "host"],
    ["docker", true, "isolated"],
  ] as const)(
    "keeps an existing %s computer on its own provider when This Mac is %s",
    async (kind, enabled, owner) => {
      const providers = { isolated: new FakeSandboxProvider(), host: new FakeSandboxProvider() };
      const described = providers.host.describe();
      vi.spyOn(providers.isolated, "describe").mockReturnValue({ ...described, id: "docker" });
      vi.spyOn(providers.host, "describe").mockReturnValue({ ...described, id: "desktop" });
      const provisions = {
        isolated: vi.spyOn(providers.isolated, "provision"),
        host: vi.spyOn(providers.host, "provision"),
      };
      const sandbox = new HostAwareSandbox(providers.isolated, providers.host, async () => enabled);
      const computer: ComputerRef = { id: "computer", providerRef: "ref", botId: "bot", kind };
      await sandbox.provision(
        { botId: "bot", homePath: "/tmp/bot", providerRef: "ref", providerKind: kind },
        ctx,
      );
      expect(provisions[owner]).toHaveBeenCalledWith(
        expect.objectContaining({ providerRef: "ref" }),
        ctx,
      );
      expect(provisions[owner === "host" ? "isolated" : "host"]).not.toHaveBeenCalled();
      const prepare = vi.spyOn(providers[owner], "prepare").mockResolvedValue(undefined);
      await sandbox.prepare(computer, ctx);
      expect(prepare).toHaveBeenCalledWith(computer, ctx);
    },
  );

  it.each([
    [false, "docker"],
    [true, "desktop"],
  ] as const)(
    "starts a computer without a machine where This Mac is set (%s)",
    async (enabled, expected) => {
      vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
      const provisions = {
        docker: vi.spyOn(DockerSandboxProvider.prototype, "provision").mockResolvedValue({
          id: "container",
          botId: "bot",
          kind: "docker",
          providerRef: "container",
        }),
        desktop: vi.spyOn(DesktopSandboxProvider.prototype, "provision").mockResolvedValue({
          id: "host",
          botId: "bot",
          kind: "desktop",
          providerRef: "host",
        }),
      };
      const sandbox = createRunSandbox("docker", {
        prisma: {
          deploymentSettings: {
            findUnique: async () => ({ computerHost: enabled ? "this-mac" : null }),
          },
        } as unknown as PrismaClient,
        secrets: { load: () => "" },
      });
      try {
        for (const providerKind of ["docker", "desktop"] as const) {
          const computer = await sandbox.provision(
            { botId: "bot", homePath: "/tmp/bot", providerKind },
            ctx,
          );
          expect(computer.kind).toBe(expected);
        }
        expect(provisions[expected === "docker" ? "desktop" : "docker"]).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("maps the Linux bot home cwd onto the desktop home", async () => {
    const desktop = new DesktopSandboxProvider();
    const computer = await desktop.provision({ botId: "alias", homePath: "/tmp/alias" }, ctx);
    let code = 1;
    for await (const event of desktop.execute(
      computer,
      { argv: ["echo", "ok"], cwd: "/home/ardurbot" },
      ctx,
    )) {
      if (event.type === "exit") code = event.code;
    }
    expect(code).toBe(0);
    await desktop.destroy(computer, ctx);
  });

  it("only switches docker deployments onto this Mac", () => {
    expect(sandboxKindForBot("docker", "this-mac")).toBe("desktop");
    expect(sandboxKindForBot("docker", "docker")).toBe("docker");
    expect(sandboxKindForBot("e2b", "this-mac")).toBe("e2b");
    expect(sandboxKindForBot("fake", "this-mac")).toBe("fake");
  });

  it("forwards pageBrowser to the routed provider", async () => {
    const isolated: SandboxProvider = new FakeSandboxProvider();
    const calls: unknown[] = [];
    isolated.pageBrowser = async (computer, request, context) => {
      calls.push({ computerId: computer.id, request, aborted: context.signal.aborted });
      return { ok: true, url: "https://example.test", title: "Example", tree: "", elements: [] };
    };
    const host = new DesktopSandboxProvider();
    const sandbox = new HostAwareSandbox(isolated, host, async () => false);
    const computer = await sandbox.provision({ botId: "page", homePath: "/tmp/page" }, ctx);
    expect(typeof sandbox.pageBrowser).toBe("function");
    await expect(
      sandbox.pageBrowser!(computer, { command: "snapshot" }, ctx),
    ).resolves.toMatchObject({
      ok: true,
      url: "https://example.test",
    });
    expect(calls).toEqual([
      { computerId: computer.id, request: { command: "snapshot" }, aborted: false },
    ]);
    await sandbox.destroy(computer, ctx);
  });
});

it("selects the remote provider only for the packaged bridge setting", async () => {
  const { RemoteHostSandboxProvider } = await import("./remote-host-sandbox.js");
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "api");
  try {
    expect(createRunSandbox("desktop", {})).toBeInstanceOf(RemoteHostSandboxProvider);
  } finally {
    vi.unstubAllEnvs();
  }
  expect(createRunSandbox("desktop", {})).toBeInstanceOf(DesktopSandboxProvider);
  expect(createRunSandbox("desktop", {})).not.toBeInstanceOf(RemoteHostSandboxProvider);
});

it("routes the run environment note to the host, leaving container notes alone", async () => {
  const host: SandboxProvider = new FakeSandboxProvider();
  host.environmentNote = vi.fn(async () => "Tools on this computer: gh (signed in).");
  const sandbox = new HostAwareSandbox(new FakeSandboxProvider(), host, async () => true);
  const computer: ComputerRef = {
    id: "host",
    botId: "bot",
    kind: "desktop",
    providerRef: "/fixture/workspace",
  };
  expect(await sandbox.environmentNote(computer, ctx)).toContain("gh (signed in)");
  expect(host.environmentNote).toHaveBeenCalledOnce();
  expect(await sandbox.environmentNote({ ...computer, kind: "docker" }, ctx)).toBeUndefined();
});
