export type ConfigValue = string | number | boolean | string[];
export interface UserConfigField {
  type: "string" | "number" | "boolean" | "directory" | "file";
  title: string;
  description: string;
  required?: boolean;
  multiple?: boolean;
  sensitive?: boolean;
  default?: ConfigValue;
  min?: number;
  max?: number;
}
export interface ServerLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}
export interface McpbManifest {
  manifest_version: string;
  name: string;
  display_name?: string;
  version: string;
  description: string;
  author: {
    name: string;
  };
  icon?: string;
  server: {
    type: "node" | "python" | "binary" | "uv";
    entry_point: string;
    mcp_config: ServerLaunch & {
      platform_overrides: Record<string, Partial<ServerLaunch>>;
    };
  };
  compatibility: {
    platforms?: string[];
    runtimes: Record<string, string>;
  };
  user_config: Record<string, UserConfigField>;
  tools: {
    name: string;
    description?: string;
  }[];
}
export declare function record(value: unknown): Record<string, unknown>;
export declare function manifestText(value: unknown, max?: number): string;
/** Fields consumed from the official MCPB 0.1–0.4 schemas; metadata is never executable. */
export declare function parseMcpbManifest(value: unknown, platform?: NodeJS.Platform): McpbManifest;
export declare function validateUserConfig(
  manifest: McpbManifest,
  value: unknown,
): Record<string, ConfigValue>;
export declare function resolveMcpbLaunch(
  manifest: McpbManifest,
  input: {
    directory: string;
    platform: NodeJS.Platform;
    variables: Record<string, string>;
    config: Record<string, ConfigValue>;
  },
): ServerLaunch & {
  cwd: string;
};
/** Credentials never enter the renderer's initial form state. */
export declare function configurationFields(
  manifest: McpbManifest,
  values: Record<string, ConfigValue>,
): {
  type: "string" | "number" | "boolean" | "directory" | "file";
  title: string;
  description: string;
  required?: boolean;
  multiple?: boolean;
  sensitive?: boolean;
  min?: number;
  max?: number;
  key: string;
  configured: boolean;
  value?: ConfigValue | undefined;
}[];
