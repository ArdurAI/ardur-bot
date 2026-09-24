import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import {
  Blocks,
  BookOpen,
  Brain,
  CloudDownload,
  Code,
  Cpu,
  Gauge,
  Monitor,
  Plug,
  Settings,
  Shield,
  Sparkles,
  User,
  Volume2,
} from "lucide-react";
import type { ComponentType, LazyExoticComponent } from "react";
import { lazy } from "react";
import type { SettingsContext, SettingsPageProps, SettingsSection } from "./settings-types";

export const SETTINGS_GROUPS = ["Settings", "Desktop app", "Customize", "Platform"] as const;
export const settingsGroupLabels = {
  Settings: msg`Settings`,
  "Desktop app": msg`Desktop app`,
  Customize: msg`Customize`,
  Platform: msg`Platform`,
};
export type SettingsRegistration = {
  id: SettingsSection;
  group: "Settings" | "Desktop app" | "Customize" | "Platform";
  label: MessageDescriptor;
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
  component: LazyExoticComponent<ComponentType<SettingsPageProps>>;
  available: (context: SettingsContext) => boolean;
};
export const always = () => true;
export const desktopOnly = (context: SettingsContext) => context.desktop;
export const ownerOnly = (context: SettingsContext) => context.isDeploymentOwner;

/** Replace one entry when a page lands; no shell switch or eager page import is needed. */
// biome-ignore format: One registration per line keeps independent settings streams easy to merge.
export const settingsSections: SettingsRegistration[] = [
  { id: "general", group: "Settings", label: msg`General`, icon: Settings, component: lazy(() => import("./settings/GeneralSettings")), available: always },
  { id: "account", group: "Settings", label: msg`Account`, icon: User, component: lazy(() => import("./AccountSettingsOverlay").then((m) => ({ default: m.GeneralSettingsPanels }))), available: always },
  { id: "privacy", group: "Settings", label: msg`Privacy`, icon: Shield, component: lazy(() => import("./settings/PrivacySettings")), available: always },
  { id: "capabilities", group: "Settings", label: msg`Capabilities`, icon: Sparkles, component: lazy(() => import("./capabilities/CapabilitiesSettings")), available: always },
  { id: "memory", group: "Settings", label: msg`Memory`, icon: Brain, component: lazy(() => import("./memory/MemorySettings")), available: always },
  { id: "models", group: "Settings", label: msg`Models`, icon: Cpu, component: lazy(() => import("./settings/ModelsSection")), available: always },
  { id: "computer", group: "Settings", label: msg`Computers`, icon: Monitor, component: lazy(() => import("./AccountSettingsOverlay").then((m) => ({ default: m.ComputerSettingsPanel }))), available: ownerOnly },
  { id: "devices", group: "Settings", label: msg`Devices`, icon: Monitor, component: lazy(() => import("./settings/DevicesSection")), available: always },
  { id: "voice", group: "Settings", label: msg`Voice`, icon: Volume2, component: lazy(() => import("./settings/VoiceSection")), available: always },
  { id: "usage", group: "Settings", label: msg`Usage`, icon: Gauge, component: lazy(() => import("./AccountSettingsOverlay").then((m) => ({ default: m.UsageSettingsPanel }))), available: always },
  { id: "learning", group: "Settings", label: msg`Learning`, icon: BookOpen, component: lazy(() => import("./settings/LearningSection")), available: always },
  { id: "system", group: "Desktop app", label: msg`System`, icon: Monitor, component: lazy(() => import("./system/SystemPage")), available: desktopOnly },
  { id: "extensions", group: "Desktop app", label: msg`Extensions`, icon: Blocks, component: lazy(() => import("./settings/McpSection")), available: desktopOnly },
  { id: "developer", group: "Desktop app", label: msg`Developer`, icon: Code, component: lazy(() => import("./settings/DeveloperSection")), available: desktopOnly },
  { id: "skills", group: "Customize", label: msg`Skills`, icon: BookOpen, component: lazy(() => import("./settings/SkillsSection")), available: always },
  { id: "integrations", group: "Customize", label: msg`Integrations`, icon: Plug, component: lazy(() => import("./settings/IntegrationsSection")), available: always },
  { id: "mcp", group: "Customize", label: msg`MCP`, icon: Plug, component: lazy(() => import("./settings/McpSection")), available: always },
  { id: "plugins", group: "Customize", label: msg`Plugins`, icon: Blocks, component: lazy(() => import("./settings/PluginsSection")), available: always },
  { id: "updates", group: "Platform", label: msg`Updates`, icon: CloudDownload, component: lazy(() => import("./AccountSettingsOverlay").then((m) => ({ default: m.UpdatesSettingsPanel }))), available: always },
];
