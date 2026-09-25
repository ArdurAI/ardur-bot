export type ExtensionConfigValue = string | number | boolean | string[];
export interface ExtensionConfigField {
  key: string;
  type: "string" | "number" | "boolean" | "directory" | "file";
  title: string;
  description: string;
  required?: boolean;
  sensitive?: boolean;
  multiple?: boolean;
  min?: number;
  max?: number;
  value?: ExtensionConfigValue;
  configured: boolean;
}
export interface DesktopExtension {
  id: string;
  name: string;
  version: string;
  description: string;
  installedAt: string;
  state: "installing" | "installed" | "removing";
  fields: ExtensionConfigField[];
}
export interface ExtensionPreview {
  id: string;
  name: string;
  version: string;
  description: string;
  fields: ExtensionConfigField[];
  tools: { name: string; description?: string }[];
  runtimes: Record<string, string>;
}
export interface DesktopCustomization {
  info(): Promise<{ packaged: boolean }>;
  list(spaceId: string | null): Promise<DesktopExtension[]>;
  prepare(spaceId: string | null): Promise<ExtensionPreview | null>;
  prepareDrop(spaceId: string | null, file: unknown): Promise<ExtensionPreview>;
  cancel(spaceId: string | null, previewId: string): Promise<void>;
  install(
    spaceId: string | null,
    previewId: string,
    values: Record<string, ExtensionConfigValue>,
  ): Promise<DesktopExtension>;
  configure(
    spaceId: string | null,
    id: string,
    values: Record<string, ExtensionConfigValue>,
  ): Promise<DesktopExtension>;
  uninstall(spaceId: string | null, id: string): Promise<void>;
  selectPaths(kind: "file" | "directory", multiple: boolean): Promise<string[] | null>;
  importSkills(spaceId: string | null): Promise<void>;
  addMarketplace(spaceId: string | null): Promise<void>;
  installPlugin(spaceId: string | null, previewId: string): Promise<void>;
  recoverPlugins(spaceId: string | null): Promise<void>;
  uninstallPlugin(spaceId: string | null, id: string): Promise<void>;
  applyConfig(spaceId: string | null, previewId: string): Promise<void>;
}
