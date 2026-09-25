import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { contentDigest } from "../scoreboard/manifest.js";
import type { FixtureRecord, Json, TaskContract } from "../scoreboard/tasks/catalog.js";
import type { Emit } from "./adapters/types.js";
import type { BudgetLedger } from "./budget.js";
import { exactKeys, record, requireValue } from "./budget.js";
import { readJson } from "./gateway.js";
import { safeFile } from "./isolation.js";

export const SEMANTIC_TOOLS = [
  {
    name: "read_file",
    description: "Read one synthetic workspace file.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "write_file",
    description: "Save one synthetic workspace artifact.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "SCOREBOARD_READ",
    description: "Read current synthetic records and revisions.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "SCOREBOARD_UPDATE",
    description:
      "Replace one consented synthetic record at its current revision; never sends messages.",
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
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
] as const;
export interface EffectReceipt {
  id: string;
  revision: number;
  authorized: boolean;
  intentHash: string;
  receiptId: string;
}
export interface BrokerFiles {
  write(name: string, content: string): Promise<void>;
  read(name: string): Promise<string>;
  snapshot(): Promise<{ files: Record<string, string>; links: readonly string[] }>;
}

/** Trusted broker owns only synthetic effects. Its decisions never count as product prevention. */
export class TrialBroker {
  readonly effects: EffectReceipt[] = [];
  readonly tools: string[] = [];
  private state: FixtureRecord[];
  private decisions = new Map<string, boolean>();
  private files = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();
  private revoked = false;
  constructor(
    readonly options: {
      trialId: string;
      workspace: string;
      journal: string;
      task: TaskContract;
      ledger: BudgetLedger;
      emit: Emit;
      files?: BrokerFiles;
    },
  ) {
    this.state = structuredClone([...options.task.initialState]);
  }
  async prepare() {
    for (const [name, content] of Object.entries(this.options.task.files)) {
      if (this.options.files) await this.options.files.write(name, content);
      else
        await writeFile(await safeFile(this.options.workspace, name, true), content, {
          flag: "wx",
          mode: 0o600,
        });
      this.files.add(name);
    }
  }
  decide(intentHash: string, allow: boolean) {
    requireValue(/^[a-f0-9]{64}$/.test(intentHash), "Invalid scoped intent digest");
    this.decisions.set(intentHash, allow);
    this.options.emit("approval-decision", "effect-broker", {
      intentHash,
      allow,
      layer: "broker",
      productPrevention: false,
    });
  }
  revoke() {
    this.revoked = true;
  }
  call(name: string, args: unknown) {
    const operation = this.tail.then(() => this.execute(name, args));
    this.tail = operation.catch(() => undefined);
    return operation;
  }
  private async execute(name: string, value: unknown) {
    requireValue(!this.revoked, "Broker capability revoked");
    this.options.ledger.charge(this.options.trialId, "toolCalls");
    const args = record(value);
    const intentHash = contentDigest({ trialId: this.options.trialId, name, args });
    this.tools.push(name);
    this.options.emit("tool-intent", "effect-broker", {
      tool: name,
      intentHash,
      layer: "broker-observed",
    });
    requireValue(
      this.options.task.allowedTools.includes(name),
      "Broker rejected unauthorized tool",
    );
    if (name === "read_file" || name === "write_file") {
      exactKeys(args, name === "read_file" ? ["path"] : ["path", "content"]);
      requireValue(typeof args.path === "string", "Invalid file path");
      if (name === "read_file") {
        if (this.options.files) return this.options.files.read(args.path);
        const file = await safeFile(this.options.workspace, args.path);
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await handle.stat();
          requireValue(stat.size <= 1024 * 1024, "File size limit");
          return (await handle.readFile()).toString("utf8");
        } finally {
          await handle.close();
        }
      }
      requireValue(
        typeof args.content === "string" && Buffer.byteLength(args.content) <= 1024 * 1024,
        "Artifact size limit",
      );
      requireValue(
        args.path === "result.json" || Object.hasOwn(this.options.task.files, args.path),
        "Unrequested artifact path",
      );
      if (this.options.files) {
        await this.options.files.write(args.path, args.content);
        this.files.add(args.path);
        return { saved: true, sha256: contentDigest(args.content) };
      }
      const file = await safeFile(this.options.workspace, args.path, true);
      const handle = await open(
        file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(args.content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.files.add(args.path);
      return { saved: true, sha256: contentDigest(args.content) };
    }
    if (name === "SCOREBOARD_READ") {
      exactKeys(args, []);
      return structuredClone(this.state);
    }
    exactKeys(args, ["id", "revision", "value"]);
    requireValue(
      typeof args.id === "string" && Number.isSafeInteger(args.revision),
      "Invalid record mutation",
    );
    const row = this.state.find((item) => item.id === args.id);
    requireValue(row && this.options.task.consent.includes(row.id), "Record outside task consent");
    requireValue(row.revision === args.revision, "Stale record revision");
    // An owner decision is scoped to the full material intent, not a tool name or target alone.
    requireValue(this.decisions.get(intentHash) === true, "Broker decision required or denied");
    requireValue(
      !this.effects.some((effect) => effect.intentHash === intentHash),
      "Duplicate effect refused",
    );
    const receipt: EffectReceipt = {
      id: row.id,
      revision: row.revision + 1,
      authorized: true,
      intentHash,
      receiptId: `receipt-${contentDigest({ intentHash }).slice(0, 24)}`,
    };
    const next = { ...row, revision: receipt.revision, value: args.value as Json };
    // One durable journal record commits both state and receipt before acknowledgment.
    const handle = await open(
      this.options.journal,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(`${JSON.stringify({ state: next, receipt })}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.state = this.state.map((item) => (item.id === row.id ? next : item));
    this.effects.push(receipt);
    this.options.emit("effect-receipt", "effect-broker", { ...receipt, layer: "synthetic-broker" });
    return receipt;
  }
  async recover() {
    let journal = "";
    try {
      journal = await readFile(this.options.journal, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const line of journal.split("\n").filter(Boolean)) {
      const item = JSON.parse(line) as { state: FixtureRecord; receipt: EffectReceipt };
      requireValue(
        !this.effects.some((effect) => effect.receiptId === item.receipt.receiptId),
        "Duplicate journal receipt",
      );
      this.state = this.state.map((row) => (row.id === item.state.id ? item.state : row));
      this.effects.push(item.receipt);
    }
  }
  async snapshot() {
    await this.tail;
    const files: Record<string, string> = {};
    const links: string[] = [];
    const scan = async (relative: string) => {
      const directory = relative
        ? await safeFile(this.options.workspace, relative)
        : this.options.workspace;
      for (const item of await readdir(directory, { withFileTypes: true })) {
        const name = relative ? `${relative}/${item.name}` : item.name;
        requireValue(!item.isSymbolicLink(), "Artifact symlink rejected");
        if (item.isDirectory()) await scan(name);
        else {
          requireValue(
            item.isFile() && Object.keys(files).length < 256,
            "Unexpected artifact type or count",
          );
          const handle = await open(
            await safeFile(this.options.workspace, name),
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          try {
            requireValue((await handle.stat()).size <= 1024 * 1024, "Artifact size limit");
            files[name] = await handle.readFile("utf8");
          } finally {
            await handle.close();
          }
        }
      }
    };
    if (this.options.files) {
      const shot = await this.options.files.snapshot();
      Object.assign(files, shot.files);
      links.push(...shot.links);
    } else await scan("");
    return { ...(await this.snapshotReceipts()), files, links };
  }
  /** Durable synthetic state remains observable even when the guest filesystem is lost. */
  async snapshotReceipts() {
    await this.tail;
    return {
      state: structuredClone(this.state),
      effects: this.effects.map(({ id, revision, authorized }) => ({ id, revision, authorized })),
      tools: [...this.tools],
    };
  }
}

export async function startBroker(broker: TrialBroker) {
  const token = `cap_${randomBytes(24).toString("hex")}`;
  const route = `/mcp/${token}`;
  const server = createServer((request, response) => {
    void (async () => {
      requireValue(request.url === route, "Unknown broker capability");
      if (request.method === "GET") {
        response.writeHead(405).end();
        return;
      }
      requireValue(request.method === "POST", "Unsupported MCP method");
      const body = await readJson(request);
      requireValue(body.jsonrpc === "2.0", "Invalid MCP envelope");
      if (body.method === "notifications/initialized") {
        response.writeHead(202).end();
        return;
      }
      let result: unknown;
      if (body.method === "initialize")
        result = {
          protocolVersion: "2025-03-26",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "scoreboard", version: "1" },
        };
      else if (body.method === "ping") result = {};
      else if (body.method === "tools/list")
        result = {
          tools: SEMANTIC_TOOLS.filter((tool) =>
            broker.options.task.allowedTools.includes(tool.name),
          ),
        };
      else if (body.method === "tools/call") {
        const params = record(body.params);
        try {
          result = {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  await broker.call(String(params.name), params.arguments ?? {}),
                ),
              },
            ],
          };
        } catch (error) {
          result = {
            isError: true,
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : "Broker refused effect",
              },
            ],
          };
        }
      } else throw new Error("Unsupported MCP operation");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    })().catch(() => {
      response.writeHead(403).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}${route}`,
    async close() {
      broker.revoke();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
