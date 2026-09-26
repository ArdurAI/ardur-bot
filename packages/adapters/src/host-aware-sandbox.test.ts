import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ComputerRef, SandboxProvider } from "@ardurbot/adapter-kit";
import { ComputerConnectionSettingsSchema } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ComputerBrowserProvider } from "./computer-browser.js";
import { MissingComputerProviderError } from "./computer-connections.js";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { DockerSandboxProvider } from "./docker-sandbox.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import {
  createRunSandbox,
  HostAwareSandbox,
  owningSandbox,
  sandboxKindForBot,
} from "./host-aware-sandbox.js";
import { KubernetesSandboxProvider } from "./kubernetes-sandbox.js";
import { FakeKubernetesApi } from "./kubernetes-test-api.js";

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
      const sandbox = new HostAwareSandbox(isolated, host, async () => true);
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
    ["desktop", true, "host"],
    ["docker", true, "isolated"],
    ["docker", false, "isolated"],
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
    "chooses a new computer with no saved kind where This Mac is %s",
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
        const computer = await sandbox.provision({ botId: "bot", homePath: "/tmp/bot" }, ctx);
        expect(computer.kind).toBe(expected);
        expect(provisions[expected === "docker" ? "desktop" : "docker"]).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("provisions a Docker computer with no machine on Docker while This Mac is on", async () => {
    vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
    const provisions = {
      docker: vi
        .spyOn(DockerSandboxProvider.prototype, "provision")
        .mockImplementation(async (request) => ({
          id: "container",
          botId: request.botId,
          kind: "docker" as const,
          providerRef: "container",
        })),
      desktop: vi.spyOn(DesktopSandboxProvider.prototype, "provision"),
    };
    const sandbox = createRunSandbox("docker", {
      prisma: {
        deploymentSettings: { findUnique: async () => ({ computerHost: "this-mac" }) },
      } as unknown as PrismaClient,
      secrets: { load: () => "" },
    });
    try {
      const computer = await sandbox.provision(
        { botId: "bot", homePath: "/tmp/bot", providerKind: "docker" },
        ctx,
      );
      expect(computer.kind).toBe("docker");
      expect(provisions.docker).toHaveBeenCalledWith(
        expect.objectContaining({ providerKind: "docker" }),
        ctx,
      );
      expect(provisions.desktop).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails a connectionless Kubernetes computer on a Docker deployment, even inside a cluster", async () => {
    vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
    vi.stubEnv("KUBERNETES_SERVICE_HOST", "10.0.0.1");
    vi.stubEnv("KUBERNETES_SERVICE_PORT", "443");
    const kubernetes = vi.spyOn(KubernetesSandboxProvider.prototype, "provision");
    const docker = vi.spyOn(DockerSandboxProvider.prototype, "provision");
    const desktop = vi.spyOn(DesktopSandboxProvider.prototype, "provision");
    const sandbox = createRunSandbox("docker", {
      prisma: {
        deploymentSettings: { findUnique: async () => ({ computerHost: "this-mac" }) },
      } as unknown as PrismaClient,
      secrets: { load: () => "" },
    });
    try {
      await expect(
        sandbox.provision(
          {
            botId: "bot",
            homePath: "/tmp/bot",
            providerRef: "pod-1",
            providerKind: "kubernetes",
          },
          ctx,
        ),
      ).rejects.toThrow(
        "This computer runs on Kubernetes, which is not configured here. Reset it in Settings, Computers to start it on this deployment's engine, or configure Kubernetes again.",
      );
      expect(kubernetes).not.toHaveBeenCalled();
      expect(docker).not.toHaveBeenCalled();
      expect(desktop).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(["e2b", "e2b-emulator", "kubernetes", "box", "fake", "none"])(
    "never runs a host computer on the server of a %s deployment",
    async (kind) => {
      vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
      const provision = vi.spyOn(DesktopSandboxProvider.prototype, "provision");
      const sandbox = createRunSandbox(kind, {
        e2bApiKey: "e2b-test",
        boxApiKey: "box-test",
        kubernetes: {
          api: new FakeKubernetesApi(),
          settings: ComputerConnectionSettingsSchema.parse({
            engine: "kubernetes",
            context: "cluster",
          }),
        },
        prisma: {
          deploymentSettings: { findUnique: async () => ({ computerHost: "this-mac" }) },
        } as unknown as PrismaClient,
        secrets: { load: () => "" },
      });
      try {
        const owner = owningSandbox(sandbox, { kind: "desktop" }, ctx);
        await expect(owner).rejects.toBeInstanceOf(MissingComputerProviderError);
        await expect(owner).rejects.toThrow(
          /^This computer runs on This (Mac|computer), which is not configured here\. Reset it in Settings, Computers to start it on this deployment's engine, or configure This (Mac|computer) again\.$/,
        );
        await expect(
          sandbox.provision(
            { botId: "bot", homePath: "/tmp/bot", providerRef: "host", providerKind: "desktop" },
            ctx,
          ),
        ).rejects.toBeInstanceOf(MissingComputerProviderError);
        expect(provision).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it.each([
    ["desktop", null, true],
    ["docker", "this-mac", true],
    ["docker", "docker", false],
    ["docker", null, false],
  ] as const)(
    "runs a host computer on a %s deployment with This Mac %s only where the host is allowed",
    async (kind, computerHost, hosted) => {
      vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
      const sandbox = createRunSandbox(kind, {
        prisma: {
          deploymentSettings: { findUnique: async () => ({ computerHost }) },
        } as unknown as PrismaClient,
        secrets: { load: () => "" },
      });
      try {
        const owner = owningSandbox(sandbox, { kind: "desktop" }, ctx);
        if (hosted) {
          await expect(owner).resolves.toBeInstanceOf(DesktopSandboxProvider);
          return;
        }
        await expect(owner).rejects.toBeInstanceOf(MissingComputerProviderError);
        const computer: ComputerRef = { id: "c", botId: "bot", kind: "desktop", providerRef: "/x" };
        const execution = (async () => {
          for await (const _ of sandbox.execute(computer, { argv: ["true"] }, ctx));
        })();
        await expect(execution).rejects.toBeInstanceOf(MissingComputerProviderError);
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

it("restricts the local desktop sandbox to registered folders and follows each add and remove", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ardurbot-registered-"));
  const outside = path.join(root, "outside");
  const added = path.join(root, "projects");
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(outside);
  await mkdir(added);
  await mkdir(path.join(root, "data"));
  const rootsFile = path.join(root, "host-roots.json");
  await writeFile(rootsFile, "[]\n");
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
  vi.stubEnv("ARDURBOT_HOST_ROOTS_FILE", rootsFile);
  try {
    const sandbox = createRunSandbox("desktop", { dataDir: path.join(root, "data") });
    const computer = await sandbox.provision({ botId: "local", homePath: "/tmp/ignored" }, ctx);
    await expect(
      collect(sandbox.execute(computer, { argv: ["mkdir", "nested"], cwd: outside }, ctx)),
    ).rejects.toThrow("Path escapes registered folders.");
    await writeFile(rootsFile, `${JSON.stringify([added])}\n`);
    await expect(
      collect(sandbox.execute(computer, { argv: ["mkdir", "-p", "nested"], cwd: added }, ctx)),
    ).resolves.toEqual([{ type: "exit", code: 0 }]);
    // Removing the folder applies to the next command.
    await writeFile(rootsFile, "[]\n");
    await expect(
      collect(sandbox.execute(computer, { argv: ["mkdir", "-p", "again"], cwd: added }, ctx)),
    ).rejects.toThrow("Path escapes registered folders.");
    await sandbox.destroy(computer, ctx);
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});

it("keeps a source checkout's host computer on the home folder when no folder list is set", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "ardurbot-source-home-"));
  const project = path.join(home, "projects", "app");
  const { mkdir, stat } = await import("node:fs/promises");
  await mkdir(project, { recursive: true });
  await mkdir(path.join(home, "data"));
  // os.homedir() reads HOME, or USERPROFILE on Windows.
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
  vi.stubEnv("ARDURBOT_HOST_ROOTS_FILE", undefined);
  try {
    const sandbox = createRunSandbox("desktop", { dataDir: path.join(home, "data") });
    const computer = await sandbox.provision({ botId: "source", homePath: "/tmp/ignored" }, ctx);
    await expect(
      collect(sandbox.execute(computer, { argv: ["mkdir", "-p", "nested"], cwd: project }, ctx)),
    ).resolves.toEqual([{ type: "exit", code: 0 }]);
    expect((await stat(path.join(project, "nested"))).isDirectory()).toBe(true);
    await sandbox.destroy(computer, ctx);
  } finally {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  }
});

async function collect<T>(source: AsyncIterable<T>) {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}

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
