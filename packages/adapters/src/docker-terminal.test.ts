import type { ComputerRef, TerminalContext } from "@ardurbot/adapter-kit";
import { encodeTerminalFrame } from "@ardurbot/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { DockerTerminal } from "./docker-terminal.js";

const context: TerminalContext = {
  operationId: "test",
  traceId: "test",
  userId: "user",
  spaceId: "space",
  botId: "bot",
  signal: new AbortController().signal,
  leaseId: "lease",
  fence: 3,
  generation: "container",
  expiresAt: 10_000,
  workingRoot: "/home/ardurbot",
};
const computer: ComputerRef = {
  id: "container",
  providerRef: "container",
  botId: "bot",
  kind: "docker",
};
afterEach(() => vi.unstubAllGlobals());
it("uses only the server-resolved supervisor and preserves binary output and input", async () => {
  const replies = [
    Response.json({ id: "session", generation: "container" }),
    new Response(encodeTerminalFrame(1, Uint8Array.of(0, 255)).slice().buffer),
    new Response(null, { status: 204 }),
    Response.json({ ok: true }),
    Response.json({ ok: true }),
  ];
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => replies.shift()!);
  vi.stubGlobal("fetch", fetch);
  const terminal = new DockerTerminal("http://supervisor.test", () => ({
    "x-ardurbot-bot-id": "bot",
    "x-ardurbot-space-id": "space",
  }));
  const session = await terminal.open(
    computer,
    { cols: 80, rows: 24, shellProfileId: "default" },
    context,
  );
  const output = [];
  for await (const frame of terminal.output(session.id)) output.push(frame);
  expect(output).toEqual([{ seq: 1, bytes: Uint8Array.of(0, 255) }]);
  await terminal.write(session.id, Uint8Array.of(128, 255));
  expect(fetch.mock.calls[0]?.[0]).toBe("http://supervisor.test/computers/container/terminal/open");
  await terminal.close(session.id, "closed");
  await expect(terminal.write(session.id, Uint8Array.of(1))).rejects.toThrow();
});
it("denies a host terminal even when the composition root has a Docker adapter", async () => {
  const terminal = new DockerTerminal("http://supervisor.test", () => ({}));
  await expect(
    terminal.open(
      { ...computer, kind: "desktop" },
      { cols: 80, rows: 24, shellProfileId: "default" },
      context,
    ),
  ).rejects.toThrow("not available");
});
