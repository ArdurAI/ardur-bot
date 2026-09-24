import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import type { Socket } from "node:net";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { createArdurToolBridge } from "./claude-mcp-bridge.js";

export function createArdurMcpProtocol(bridge: ReturnType<typeof createArdurToolBridge>) {
  const server = new Server({ name: "ardur", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: bridge.tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema: { ...inputSchema, type: "object" as const },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) =>
    bridge.call(params.name, params.arguments ?? {}),
  );
  return server;
}

/** A stdio relay connects to a private run socket; SDK handlers stay beside applyTool. */
export async function startArdurMcpServer(bridge: ReturnType<typeof createArdurToolBridge>) {
  const directory = await mkdtemp(join(tmpdir(), "ardur-mcp-"));
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\ardur-tools-${randomUUID()}`
      : join(directory, "tools.sock");
  const accessKey = randomBytes(32).toString("hex");
  const sockets = new Set<Socket>();
  const servers = new Set<Server>();
  const listener = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    if (sockets.size > 8) {
      socket.destroy();
      return;
    }
    const timeout = setTimeout(() => socket.destroy(), 5000);
    timeout.unref();
    let pending = Buffer.alloc(0);
    const authenticate = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > 4096) {
        socket.destroy();
        return;
      }
      const end = pending.indexOf(10);
      if (end < 0) return;
      const key = pending.subarray(0, end);
      if (key.length !== accessKey.length || !timingSafeEqual(key, Buffer.from(accessKey))) {
        socket.destroy();
        return;
      }
      clearTimeout(timeout);
      socket.removeListener("data", authenticate);
      socket.pause();
      const rest = pending.subarray(end + 1);
      if (rest.length) socket.unshift(rest);
      const server = createArdurMcpProtocol(bridge);
      servers.add(server);
      void server
        .connect(new StdioServerTransport(socket, socket))
        .then(() => socket.resume())
        .catch(() => socket.destroy());
    };
    socket.on("data", authenticate);
    socket.once("close", () => clearTimeout(timeout));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(socketPath, resolve);
    });
    if (process.platform !== "win32") await chmod(socketPath, 0o600);
  } catch (error) {
    listener.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    config: {
      command: process.execPath,
      env: { ELECTRON_RUN_AS_NODE: "1" },
      args: [
        "-e",
        'const s=require("node:net").connect(process.argv[1],()=>{s.write(process.argv[2]+"\\n");process.stdin.pipe(s);});s.pipe(process.stdout);s.on("error",()=>process.exit(1));s.on("close",()=>process.exit());process.stdin.on("end",()=>s.end());',
        socketPath,
        accessKey,
      ],
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.allSettled([...servers].map((server) => server.close()));
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
