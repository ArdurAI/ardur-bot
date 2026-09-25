import type { BundleFile } from "./files.js";

type PluginSource =
  | string
  | {
      source: "github";
      repo: string;
      ref?: string;
      sha?: string;
    }
  | {
      source: "url";
      url: string;
      ref?: string;
      sha?: string;
    };
export interface PluginManifest {
  name: string;
  description?: string;
  version?: string;
  author?: {
    name: string;
  };
  keywords?: string[];
  skills?: string[];
  commands?: string[];
  outputStyles?: string[];
  mcpServers?: string[] | Record<string, PluginServer>;
  unsupported: string[];
}
export interface MarketplaceEntry extends PluginManifest {
  source: PluginSource;
  category?: string;
  tags?: string[];
  strict: boolean;
}
export interface PluginServer {
  type?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}
export declare function parsePluginServers(value: unknown): Record<string, PluginServer>;
/** Only documented component fields are interpreted. Unknown metadata cannot execute. */
export declare function parsePluginJson(text: string): unknown;
export declare function parsePluginManifest(value: unknown): PluginManifest;
export declare function parseMarketplace(value: unknown): {
  name: string;
  owner: {
    name: string;
  };
  plugins: MarketplaceEntry[];
};
export declare function pluginFiles(files: BundleFile[], source: string): BundleFile[];
export declare function planPlugin(
  files: BundleFile[],
  entry?: MarketplaceEntry,
): {
  name: string;
  description: string;
  version: string | undefined;
  author:
    | {
        name: string;
      }
    | undefined;
  skills: {
    path: string;
    content: string;
  }[];
  commands: {
    path: string;
    content: string;
  }[];
  instructions: {
    path: string;
    content: string;
  }[];
  servers: Record<string, PluginServer>;
  configurationPaths: string[];
  digest: string;
};
/** Keep launch material in the encrypted store, never in the extracted package configuration. */
export declare function pluginInstallFiles(
  files: BundleFile[],
  plan: ReturnType<typeof planPlugin>,
): BundleFile[];
