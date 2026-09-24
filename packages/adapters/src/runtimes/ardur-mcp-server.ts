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
  if (process.platform === "win32")
    throw new Error("Native runtime tool transport is not available on Windows yet.");
  const directory = await mkdtemp(join(tmpdir(), "ardur-mcp-"));
  const socketPath = join(directory, "tools.sock");
  const sockets = new Set<Socket>();
  const servers = new Set<Server>();
  const listener = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    const server = createArdurMcpProtocol(bridge);
    servers.add(server);
    void server.connect(new StdioServerTransport(socket, socket)).catch(() => socket.destroy());
  });
  try {
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
  } catch (error) {
    listener.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    config: {
      command: process.execPath,
      args: [
        "-e",
        'const s=require("node:net").connect(process.argv[1]);process.stdin.pipe(s);s.pipe(process.stdout);s.on("error",()=>process.exit(1));s.on("close",()=>process.exit());process.stdin.on("end",()=>s.end());',
        socketPath,
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
