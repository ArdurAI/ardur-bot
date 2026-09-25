import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AdapterContext,
  CommandRequest,
  ComputerRef,
  ConnectorCall,
  ConnectorEvent,
  ConnectorTool,
  PortableFile,
  ProcessEvent,
} from "@ardurbot/adapter-kit";
import {
  ComposioEmulator,
  FakeSandboxProvider,
  teamBotWorkspaceDirectory,
} from "@ardurbot/adapters";
import type { PrismaClient } from "@ardurbot/db";
import { contentDigest } from "../manifest.js";
import type { FixtureRecord, Json, TaskContract } from "../tasks/catalog.js";
import type { ReplayTiming } from "./protocol.js";
import { REPLAY_SCHEDULES } from "./protocol.js";

export const FIXTURE_TOOLS: ConnectorTool[] = [
  {
    name: "SCOREBOARD_READ",
    description: "Read the current synthetic task records and revisions.",
    readOnly: true,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "SCOREBOARD_UPDATE",
    description:
      "Replace one explicitly consented synthetic record at its current revision. Never sends messages or approves a pending request.",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        revision: { type: "integer", minimum: 1 },
        value: { type: "object" },
      },
      required: ["id", "revision", "value"],
      additionalProperties: false,
    },
  },
];

/** Cancellation shape consumed by the resource collector when it stops replay work. */
export function replayCancellation(signal: AbortSignal) {
  return new Error("Synthetic call cancelled", { cause: signal.reason });
}

/** Disposable fixture schema only; never applied to an owner database or Prisma migrations. */
export async function initializeFixtureDatabase(prisma: PrismaClient) {
  await prisma.$executeRaw`CREATE SCHEMA IF NOT EXISTS scoreboard_fixture`;
  await prisma.$executeRaw`CREATE TABLE IF NOT EXISTS scoreboard_fixture.records (scope text NOT NULL, id text NOT NULL, revision integer NOT NULL, value jsonb NOT NULL, consent boolean NOT NULL, PRIMARY KEY (scope, id))`;
  await prisma.$executeRaw`CREATE TABLE IF NOT EXISTS scoreboard_fixture.effects (scope text NOT NULL, execution_id text NOT NULL, id text NOT NULL, revision integer NOT NULL, PRIMARY KEY (scope, execution_id))`;
}

export class DepartmentServices extends ComposioEmulator {
  private prisma: PrismaClient | undefined;
  private task: TaskContract | undefined;
  private scope = "";
  private remoteUrl: string | null = null;
  private toolDelayMs = 0;
  private pending = new Map<string, { call: ConnectorCall; context: AdapterContext }>();
  constructor() {
    super([{ slug: "SCOREBOARD", name: "Synthetic task records", logo: null, noAuth: true }]);
  }

  async transport(mode: "local" | "remote", timing: ReplayTiming) {
    this.toolDelayMs = REPLAY_SCHEDULES[timing].toolMs;
    if (mode === "local") return async () => undefined;
    const server = createServer((request, response) => {
      void (async () => {
        if (request.method !== "POST" || request.url !== "/tool")
          throw new Error("Invalid fixture endpoint");
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 64 * 1024) throw new Error("Fixture call exceeds limit");
          chunks.push(Buffer.from(chunk));
        }
        const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          nonce: string;
          call: ConnectorCall;
        };
        const admitted = this.pending.get(input.nonce);
        this.pending.delete(input.nonce);
        if (!admitted || contentDigest(input.call) !== contentDigest(admitted.call))
          throw new Error("Unadmitted fixture call");
        const events: ConnectorEvent[] = [];
        for await (const event of this.executeLocal(admitted.call, admitted.context))
          events.push(event);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(events));
      })().catch(() => {
        response.writeHead(400, { "content-type": "application/json" });
        response.end('{"error":"fixture call refused"}');
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    this.remoteUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/tool`;
    return async () => {
      this.remoteUrl = null;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    };
  }

  async seed(prisma: PrismaClient, task: TaskContract, scope: string) {
    this.prisma = prisma;
    this.task = task;
    this.scope = scope;
    for (const row of task.initialState)
      await prisma.$executeRaw`INSERT INTO scoreboard_fixture.records (scope, id, revision, value, consent) VALUES (${scope}, ${row.id}, ${row.revision}, ${JSON.stringify(row.value)}::jsonb, ${task.consent.includes(row.id)})`;
  }

  override async discoverTools(context: AdapterContext): Promise<ConnectorTool[]> {
    const connected = context.connectedConnections?.some(
      (connection) =>
        connection.connectorId === "composio" && connection.externalId.startsWith("SCOREBOARD"),
    );
    if (!connected || context.botId !== this.scope) return [];
    return FIXTURE_TOOLS.filter((tool) => this.task?.allowedTools.includes(tool.name));
  }

  async snapshot(): Promise<FixtureRecord[]> {
    if (!this.prisma) throw new Error("Fixture service not seeded");
    return this.prisma.$queryRaw<
      FixtureRecord[]
    >`SELECT id, revision, value FROM scoreboard_fixture.records WHERE scope = ${this.scope} ORDER BY id`;
  }

  async effects() {
    if (!this.prisma) throw new Error("Fixture service not seeded");
    const rows = await this.prisma.$queryRaw<
      { id: string; revision: number }[]
    >`SELECT id, revision FROM scoreboard_fixture.effects WHERE scope = ${this.scope} ORDER BY id, revision`;
    return rows.map((row) => ({ ...row, authorized: true }));
  }

  async revokeConsent(id: string) {
    if (!this.prisma) throw new Error("Fixture service not seeded");
    await this.prisma
      .$executeRaw`UPDATE scoreboard_fixture.records SET consent = false WHERE scope = ${this.scope} AND id = ${id}`;
  }

  override async *execute(
    call: ConnectorCall,
    context: AdapterContext,
  ): AsyncIterable<ConnectorEvent> {
    if (this.toolDelayMs) await delay(this.toolDelayMs, undefined, { signal: context.signal });
    if (!this.remoteUrl) {
      yield* this.executeLocal(call, context);
      return;
    }
    const nonce = randomUUID();
    this.pending.set(nonce, { call, context });
    try {
      const response = await fetch(this.remoteUrl, {
        method: "POST",
        body: JSON.stringify({ nonce, call }),
        signal: context.signal,
      });
      if (!response.ok) throw new Error("Remote synthetic call refused");
      const events = (await response.json()) as ConnectorEvent[];
      for (const event of events) yield event;
    } finally {
      this.pending.delete(nonce);
    }
  }

  private async *executeLocal(
    call: ConnectorCall,
    context: AdapterContext,
  ): AsyncIterable<ConnectorEvent> {
    if (
      !this.prisma ||
      context.botId !== this.scope ||
      !(await this.discoverTools(context)).some((tool) => tool.name === call.tool)
    )
      throw new Error("Synthetic tool permission denied");
    if (context.signal.aborted) throw replayCancellation(context.signal);
    if (call.tool === "SCOREBOARD_READ") {
      if (Object.keys(call.args).length) throw new Error("Unexpected read arguments");
      yield { type: "result", data: await this.snapshot() };
      return;
    }
    const { id, revision, value } = call.args;
    if (
      Object.keys(call.args).sort().join(",") !== "id,revision,value" ||
      typeof id !== "string" ||
      !Number.isSafeInteger(revision) ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value)
    )
      throw new Error("Invalid synthetic update");
    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.$queryRaw<
        FixtureRecord[]
      >`UPDATE scoreboard_fixture.records SET revision = revision + 1, value = ${JSON.stringify(value)}::jsonb WHERE scope = ${this.scope} AND id = ${id} AND revision = ${revision as number} AND consent = true RETURNING id, revision, value`;
      if (updated.length !== 1) throw new Error("Stale revision or revoked consent");
      if (context.signal.aborted) throw replayCancellation(context.signal);
      await tx.$executeRaw`INSERT INTO scoreboard_fixture.effects (scope, execution_id, id, revision) VALUES (${this.scope}, ${call.executionId}, ${id}, ${updated[0]!.revision})`;
      return updated[0]!;
    });
    yield { type: "result", data: result };
  }
}

/** Real temporary-file IO through the ordinary computer tools; shell and network are unavailable. */
export class DepartmentSandbox extends FakeSandboxProvider {
  private seeded = new Set<string>();
  constructor(
    private readonly root: string,
    private readonly task: TaskContract,
  ) {
    super();
  }

  private filePath(computer: ComputerRef, file: string) {
    const base = path.resolve(this.root, computer.id);
    const normalized = file.replace(/^\/home\/ardurbot\//, "");
    const target = path.resolve(base, normalized);
    if (!target.startsWith(`${base}${path.sep}`) || normalized.includes("\0"))
      throw new Error("Fixture path outside workspace");
    return target;
  }

  override async provision(request: { botId: string; homePath: string }, context: AdapterContext) {
    const computer = await super.provision(request, context);
    if (!this.seeded.has(computer.id)) {
      for (const [file, content] of Object.entries(this.task.files))
        await this.writeFile(
          computer,
          {
            path: context.botId ? `${teamBotWorkspaceDirectory(context.botId)}/${file}` : file,
            content: Buffer.from(content),
          },
          context,
        );
      this.seeded.add(computer.id);
    }
    return computer;
  }

  override async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    const target = this.filePath(computer, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content, { mode: 0o600 });
    await super.writeFile(computer, file, context);
  }

  override async readFile(
    computer: ComputerRef,
    file: string,
    _context: AdapterContext,
    options?: { maxBytes?: number; preview?: boolean },
  ) {
    const content = await readFile(this.filePath(computer, file));
    if (!options?.preview && options?.maxBytes !== undefined && content.length > options.maxBytes)
      throw new Error("Fixture file exceeds limit");
    return new Uint8Array(options?.preview ? content.subarray(0, options.maxBytes) : content);
  }

  override async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    // The production computer lifecycle prepares these two directories before invoking the agent.
    if (
      context.botId &&
      JSON.stringify(request.argv) ===
        JSON.stringify(["mkdir", "-p", "shared", teamBotWorkspaceDirectory(context.botId)])
    ) {
      for (const directory of request.argv.slice(2))
        await mkdir(this.filePath(computer, directory), { recursive: true });
      yield { type: "exit", code: 0 };
      return;
    }
    yield { type: "stderr", data: "Shell is outside this task's permissions." };
    yield { type: "exit", code: 126 };
  }

  async snapshotFiles(
    homeKey: string,
    botId: string,
  ): Promise<{ files: Record<string, string>; links: readonly string[] }> {
    const box = this.boxes.get(`fake-${homeKey}`);
    const files: Record<string, string> = {};
    if (!box) return { files, links: [] };
    const prefix = `${teamBotWorkspaceDirectory(botId)}/`;
    for (const file of box.files.keys())
      files[file.startsWith(prefix) ? file.slice(prefix.length) : file] = await readFile(
        this.filePath(box.ref, file),
        "utf8",
      );
    return { files, links: [] };
  }
}

export type StateMutation = { id: string; revision: number; value: Json };
