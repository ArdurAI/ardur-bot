import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ComputerRef, TerminalContext } from "@ardurbot/adapter-kit";
import { ComputerConnectionSettingsSchema } from "@ardurbot/contracts";
import { SshSettingsSchema } from "@ardurbot/contracts/fleet";
import { expect, it, vi } from "vitest";
import { FleetDockerSandboxProvider } from "./docker-sandbox.js";
import { fleetComputerKey } from "./linux-sandbox.js";
import { SshSandboxProvider } from "./ssh-sandbox.js";
import { FleetTerminal } from "./terminal.js";

it.each(["supplied", "ssh", "tls"])(
  "redacts %s transport credentials from terminal stderr",
  async (kind) => {
    vi.stubEnv("LOG_LEVEL", "debug");
    vi.stubEnv("ARDUR_DETAILED_PROCESS_LOGS", "1");
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const secret = "a1".repeat(32);
    const multiline = `fixture-private-header\n${secret}\nfixture-private-footer`;
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: 0,
      signalCode: null,
      kill: vi.fn(),
    }) as unknown as ChildProcessWithoutNullStreams;
    const context: TerminalContext = {
      operationId: "fixture",
      traceId: "fixture",
      userId: "fixture",
      spaceId: "space",
      signal: new AbortController().signal,
      leaseId: "lease",
      fence: 1,
      generation: "generation",
      workingRoot: "/fixture",
      expiresAt: Date.now() + 10_000,
    };
    const computer = {
      id: "fixture",
      botId: "bot",
      providerRef: `ardurbot-${fleetComputerKey("space", "bot").slice(0, 40)}`,
    } as ComputerRef;
    const processes = {
      start: vi.fn(async () => child),
      run: vi.fn(async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })),
    };
    const ssh = new SshSandboxProvider(
      SshSettingsSchema.parse({
        host: "computer.invalid",
        user: "fixture",
        authentication: "private-key",
      }),
      processes,
      async () => multiline,
    );
    vi.spyOn(ssh, "root").mockResolvedValue("/fixture");
    const tls = new FleetDockerSandboxProvider(
      ComputerConnectionSettingsSchema.parse({
        engine: "docker",
        endpoint: "tcp://computer.invalid:2376",
      }),
      processes,
      async () => ({ ca: "fixture-ca", cert: "fixture-cert", key: multiline }),
    );
    let cleanup: (() => Promise<void>) | undefined;
    const terminal = new FleetTerminal(
      async (_computer, argv) => {
        const started =
          kind === "ssh"
            ? await ssh.start(computer, argv, context)
            : kind === "tls"
              ? await tls.start(computer, argv, context)
              : { child, secrets: [multiline], cleanup: async () => undefined };
        cleanup = started.cleanup;
        expect(started.secrets).toContain(multiline);
        return started;
      },
      async () => "/fixture",
    );
    try {
      await terminal.open(computer, { cols: 80, rows: 24, shellProfileId: "default" }, context);
      (child.stderr as PassThrough).end(`${multiline}\n`);
      child.emit("close", 0);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const logs = write.mock.calls.map(([line]) => String(line)).join("");
      expect(logs).toContain("fleet-terminal stderr: [redacted]");
      expect(logs).not.toContain(secret);
      expect(logs).not.toContain("fixture-private-header");
      expect(logs).not.toContain("fixture-private-footer");
    } finally {
      await terminal.closeAll();
      await cleanup?.();
      write.mockRestore();
      vi.unstubAllEnvs();
    }
  },
);
