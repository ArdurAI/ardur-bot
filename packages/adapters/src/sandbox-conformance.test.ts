import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ComputerRef, ProcessEvent, SandboxProvider } from "@ardurbot/adapter-kit";
import { ComputerConnectionSettingsSchema } from "@ardurbot/contracts";
import { SshSettingsSchema } from "@ardurbot/contracts/fleet";
import { SshSandboxProvider } from "@ardurbot/host-runtime/fleet/ssh-sandbox";
import { fakeSshTransport } from "@ardurbot/host-runtime/fleet/test-process";
import { describe, expect, it, vi } from "vitest";
import { BoxSandboxEmulator } from "./box-emulator.js";
import { DaytonaSandboxEmulator } from "./daytona-emulator.js";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { DockerSandboxProvider } from "./docker-sandbox.js";
import { fakePodmanSupervisor } from "./docker-test-supervisor.js";
import { ManagedSandboxEmulator } from "./e2b-emulator.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { KubernetesSandboxProvider } from "./kubernetes-sandbox.js";
import { FakeKubernetesApi } from "./kubernetes-test-api.js";
import { provisionPrepared } from "./sandbox-test-support.js";

const ctx = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

async function drain(provider: SandboxProvider, computer: ComputerRef) {
  let stdout = "";
  for await (const event of provider.execute(computer, { argv: ["echo", "graphical-ok"] }, ctx)) {
    if (event.type === "stdout") stdout += event.data;
    if (event.type === "exit") expect(event.code).toBe(0);
  }
  return stdout;
}

describe("sandbox conformance", () => {
  it("runs the same graphical command across fake, managed-provider emulators, and desktop", async () => {
    const fake = new FakeSandboxProvider();
    const managed = new ManagedSandboxEmulator();
    const daytona = new DaytonaSandboxEmulator();
    const box = new BoxSandboxEmulator();
    const desktop = new DesktopSandboxProvider();
    const a = await provisionPrepared(fake, { botId: "bot-a", homePath: "/tmp/a" }, ctx);
    const b = await provisionPrepared(managed, { botId: "bot-b", homePath: "/tmp/b" }, ctx);
    const c = await provisionPrepared(daytona, { botId: "bot-c", homePath: "/tmp/c" }, ctx);
    const d = await provisionPrepared(box, { botId: "bot-d", homePath: "/tmp/d" }, ctx);
    const e = await provisionPrepared(desktop, { botId: "bot-e", homePath: "/tmp/e" }, ctx);
    const outA = await drain(fake, a);
    const outB = await drain(managed, b);
    const outC = await drain(daytona, c);
    const outD = await drain(box, d);
    const outE = await drain(desktop, e);
    expect(outA).toContain("graphical-ok");
    expect(outB).toContain("graphical-ok");
    expect(outC).toContain("graphical-ok");
    expect(outD).toContain("graphical-ok");
    expect(outE).toContain("graphical-ok");
    expect(new Set([a.id, b.id, c.id, d.id, e.id]).size).toBe(5);
    await fake.destroy(a, ctx);
    await managed.destroy(b, ctx);
    await daytona.destroy(c, ctx);
    await box.destroy(d, ctx);
    await desktop.destroy(e, ctx);
  });

  it("offers the same observation, action, and workspace contract across providers", async () => {
    const ssh = await fakeSshTransport();
    const kubernetesApi = new FakeKubernetesApi();
    const providers: SandboxProvider[] = [
      new SshSandboxProvider(
        SshSettingsSchema.parse({
          host: "computer.invalid",
          user: "runner",
          baseDirectory: ssh.root,
        }),
        ssh.processes,
      ),
      new KubernetesSandboxProvider(
        kubernetesApi,
        ComputerConnectionSettingsSchema.parse({ engine: "kubernetes" }),
      ),
      new FakeSandboxProvider(),
      new ManagedSandboxEmulator(),
      new DaytonaSandboxEmulator(),
      new BoxSandboxEmulator(),
      new DesktopSandboxProvider(),
    ];
    for (const [index, provider] of providers.entries()) {
      const computer = await provisionPrepared(
        provider,
        { botId: `portable-${index}`, homePath: `/tmp/portable-${index}` },
        ctx,
      );
      await provider.prepare(computer, ctx);
      await provider.writeFile(
        computer,
        { path: "notes/result.txt", content: new TextEncoder().encode("portable") },
        ctx,
      );
      expect(await provider.listFiles(computer, "notes", ctx)).toEqual([
        { path: "notes/result.txt", kind: "file", size: 8 },
      ]);
      expect(
        new TextDecoder().decode(await provider.readFile(computer, "notes/result.txt", ctx)),
      ).toBe("portable");
      const binary = Uint8Array.from([0, 255, 1, 128]);
      await provider.writeFile(
        computer,
        { path: "bin/tool", content: binary, executable: true },
        ctx,
      );
      expect(await provider.readFile(computer, "bin/tool", ctx)).toEqual(binary);
      expect(await provider.listFiles(computer, "bin", ctx)).toEqual([
        { path: "bin/tool", kind: "file", size: 4, executable: true },
      ]);
      if (provider.describe().capabilities.graphical || provider.describe().id === "desktop") {
        const acted = await provider.act(
          computer,
          { actions: [{ kind: "clipboard", text: "visible" }], observe: true },
          ctx,
        );
        expect(acted.completed).toBe(1);
        expect(acted.observation?.image.byteLength).toBeGreaterThan(0);
      } else {
        expect((await provider.connectScreen(computer, { view: "stream" }, ctx)).url).toBeNull();
        await expect(provider.observe(computer, ctx)).rejects.toThrow(
          "Not available on this computer",
        );
      }
      const exported = [];
      for await (const file of provider.exportWorkspace(computer, ctx)) exported.push(file);
      expect(exported.map((file) => file.path)).toContain("notes/result.txt");
      expect(exported.find((file) => file.path === "bin/tool")).toMatchObject({
        content: binary,
        executable: true,
      });
      await provider.destroy(computer, ctx);
    }
    kubernetesApi.dispose();
    await ssh.close();
  });

  it("desktop executor refuses paths outside the computer home", async () => {
    const desktop = new DesktopSandboxProvider();
    const computer = await desktop.provision({ botId: "grant", homePath: "/tmp/grant" }, ctx);
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

  it("desktop executor times out and kills descendants that inherited its pipes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ardurbot-desktop-timeout-"));
    const desktop = new DesktopSandboxProvider({ root });
    const computer = await desktop.provision({ botId: "timeout", homePath: "/unused" }, ctx);
    const marker = path.join(computer.providerRef, "descendant-survived");
    const events: ProcessEvent[] = [];
    const startedAt = Date.now();

    for await (const event of desktop.execute(
      computer,
      {
        argv: ["bash", "-lc", "(sleep 0.2; printf survived > descendant-survived) & wait"],
        timeoutMs: 40,
      },
      ctx,
    )) {
      events.push(event);
    }

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(events).toContainEqual({ type: "exit", code: 124 });
    expect(events).toContainEqual({
      type: "stderr",
      data: "command timed out after 40 ms\n",
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(() => readFileSync(marker)).toThrow();

    await desktop.destroy(computer, ctx);
    rmSync(root, { recursive: true, force: true });
  });

  it("desktop executor aborts and kills a running command", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ardurbot-desktop-abort-"));
    const desktop = new DesktopSandboxProvider({ root });
    const computer = await desktop.provision({ botId: "abort", homePath: "/unused" }, ctx);
    const controller = new AbortController();
    const events: ProcessEvent[] = [];
    setTimeout(() => controller.abort(), 25);

    for await (const event of desktop.execute(
      computer,
      { argv: ["bash", "-lc", "sleep 10"], timeoutMs: 5_000 },
      { ...ctx, signal: controller.signal },
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({ type: "exit", code: 130 });
    expect(events).toContainEqual({ type: "stderr", data: "command aborted\n" });

    await desktop.destroy(computer, ctx);
    rmSync(root, { recursive: true, force: true });
  });

  it("treats a repeated destroy as success so a stale deletion retry is safe", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ardurbot-destroy-idempotent-"));
    const providers: SandboxProvider[] = [
      new FakeSandboxProvider(),
      new ManagedSandboxEmulator(),
      new DaytonaSandboxEmulator(),
      new BoxSandboxEmulator(),
      new DesktopSandboxProvider({ root }),
    ];
    for (const [index, provider] of providers.entries()) {
      const computer = await provisionPrepared(
        provider,
        { botId: `destroy-twice-${index}`, homePath: `/tmp/destroy-twice-${index}` },
        ctx,
      );
      await provider.destroy(computer, ctx);
      await expect(provider.destroy(computer, ctx)).resolves.toBeUndefined();
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("reuses one desktop machine per bot", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ardurbot-desktop-reuse-"));
    const desktop = new DesktopSandboxProvider({ root });
    const first = await desktop.provision({ botId: "stable", homePath: "/unused" }, ctx);
    const second = await desktop.provision({ botId: "stable", homePath: "/unused" }, ctx);

    expect(first).toMatchObject({ fresh: true });
    expect(second).toMatchObject({ id: first.id, providerRef: first.providerRef, fresh: false });
    expect(desktop.boxes.size).toBe(1);

    await desktop.destroy(second, ctx);
    rmSync(root, { recursive: true, force: true });
  });

  it("desktop file writes do not follow a final symlink outside the workspace", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ardurbot-desktop-symlink-"));
    const desktop = new DesktopSandboxProvider({ root });
    const computer = await desktop.provision({ botId: "symlink", homePath: "/unused" }, ctx);
    const outside = path.join(root, "outside.txt");
    writeFileSync(outside, "before");
    symlinkSync(outside, path.join(computer.providerRef, "escape.txt"));

    await expect(
      desktop.writeFile(computer, {
        path: "escape.txt",
        content: new TextEncoder().encode("after"),
      }),
    ).rejects.toThrow();
    expect(readFileSync(outside, "utf8")).toBe("before");

    await desktop.destroy(computer, ctx);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("computer lifecycle conformance", () => {
  it("uses the same exec, file, sleep, wake and destroy contract on Podman and Kubernetes", async () => {
    const api = new FakeKubernetesApi();
    vi.stubGlobal("fetch", fakePodmanSupervisor(ctx));
    const providers: SandboxProvider[] = [
      new DockerSandboxProvider("http://supervisor.test", "test-token", {
        name: "podman",
        socket: "/tmp/podman.sock",
      }),
      new KubernetesSandboxProvider(
        api,
        ComputerConnectionSettingsSchema.parse({ engine: "kubernetes" }),
      ),
    ];
    try {
      for (const provider of providers) {
        const request = {
          botId: "conformance",
          homePath: "/unused",
          imageProfile: "developer" as const,
        };
        const computer = await provisionPrepared(provider, request, ctx);
        expect(await drain(provider, computer)).toContain("graphical-ok");
        await provider.writeFile(
          computer,
          { path: "checkpoint.txt", content: new TextEncoder().encode("keep") },
          ctx,
        );
        const files = [];
        for await (const file of provider.exportWorkspace(computer, ctx)) files.push(file);
        await provider.stop(computer, ctx);
        const awake = await provisionPrepared(provider, request, ctx);
        expect(
          new TextDecoder().decode(await provider.readFile(awake, "checkpoint.txt", ctx)),
        ).toBe("keep");
        await provider.destroy(awake, ctx);
        const replacement = await provisionPrepared(provider, request, ctx);
        await provider.importWorkspace(
          replacement,
          (async function* () {
            yield* files;
          })(),
          ctx,
        );
        expect(
          new TextDecoder().decode(await provider.readFile(replacement, "checkpoint.txt", ctx)),
        ).toBe("keep");
        await provider.destroy(replacement, ctx);
        await provider.destroy(replacement, ctx);
      }
    } finally {
      vi.unstubAllGlobals();
      api.dispose();
    }
  });
});
