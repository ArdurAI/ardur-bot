import type { AvatarStyle, SpaceMemoryConfig } from "@ardurbot/contracts";

export type SettingsSection =
  | "general"
  | "account"
  | "privacy"
  | "capabilities"
  | "memory"
  | "models"
  | "devices"
  | "computer"
  | "voice"
  | "usage"
  | "learning"
  | "system"
  | "extensions"
  | "developer"
  | "skills"
  | "integrations"
  | "mcp"
  | "plugins"
  | "updates";
export type SettingsContext = {
  desktop: boolean;
  isDeploymentOwner: boolean;
  desktopUpdates?: boolean;
  serverUpdates?: boolean;
};
export type SettingsPageProps = {
  email?: string | null;
  name: string;
  usage?: { runs: number; inputTokens: number; outputTokens: number } | null;
  initialProvider?: string;
  onOpenBotRuntime?: () => void;
  initialIntegration?: string;
  avatarStyle: AvatarStyle;
  onAvatarStyleChange: (style: AvatarStyle) => Promise<void>;
  isDeploymentOwner?: boolean;
  sandboxProvider?: string | null;
  messagingEnabled?: boolean;
  onOpenMessaging?: () => void;
  memoryConfig: SpaceMemoryConfig | null | undefined;
  onMemoryConfigChange: (config: SpaceMemoryConfig | null) => void;
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
  navigate: (section: SettingsSection) => void;
};
