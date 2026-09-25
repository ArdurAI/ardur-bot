import { McpServerSchema } from "@ardurbot/contracts";
import type {
  LocalImportAction,
  LocalImportCategory,
  LocalImportTool,
} from "@ardurbot/contracts/local-import";
import {
  LocalImportResponseSchema,
  LocalImportStatusSchema,
} from "@ardurbot/contracts/local-import";
import { rpc } from "./api";

export const localImport = {
  servers: async () =>
    McpServerSchema.array()
      .parse(await rpc("mcp/servers/list", {}))
      .filter((server) => server.imported),
  credentials: async (input: {
    serverId: string;
    env: Record<string, string>;
    headers: Record<string, string>;
  }) => rpc("localImport/credentials", input),
  status: async () => LocalImportStatusSchema.parse(await rpc("localImport/status", {})),
  configure: async (input: {
    autoImport?: boolean;
    roots?: Partial<Record<LocalImportTool, string>>;
    selection?: Partial<Record<LocalImportTool, LocalImportCategory[]>>;
  }) => LocalImportStatusSchema.parse(await rpc("localImport/configure", input)),
  run: async (action: LocalImportAction) =>
    LocalImportResponseSchema.parse(await rpc("localImport/run", action)),
};
