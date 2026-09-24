import type { LucideIcon } from "lucide-react";
import { Blocks, Code, FileText, Plug, Puzzle } from "lucide-react";
import { lazy, Suspense } from "react";
import { desktopBridge } from "../../lib/desktop";

const pages = {
  extensions: { component: lazy(() => import("./ExtensionsPage")), icon: Blocks, desktop: true },
  developer: { component: lazy(() => import("./DeveloperPage")), icon: Code, desktop: true },
  skills: { component: lazy(() => import("./SkillsPage")), icon: FileText, desktop: false },
  connectors: { component: lazy(() => import("./ConnectorsPage")), icon: Plug, desktop: false },
  plugins: { component: lazy(() => import("./PluginsPage")), icon: Puzzle, desktop: false },
};
export type CustomizeSectionId = keyof typeof pages;
export function customizeRegistration(
  id: CustomizeSectionId,
  label: string,
): { id: CustomizeSectionId; label: string; icon: LucideIcon; group: "desktop" | "customize" }[] {
  const page = pages[id];
  return page.desktop && !desktopBridge()
    ? []
    : [{ id, label, icon: page.icon, group: page.desktop ? "desktop" : "customize" }];
}
export function CustomizePage({
  section,
  onNavigate,
}: {
  section: string;
  onNavigate(id: CustomizeSectionId): void;
}) {
  if (!Object.hasOwn(pages, section)) return null;
  const page = pages[section as CustomizeSectionId];
  if (page.desktop && !desktopBridge()) return null;
  const Component = page.component;
  return (
    <Suspense fallback={<div className="h-40 animate-pulse rounded-lg bg-muted" />}>
      <Component onNavigate={onNavigate} />
    </Suspense>
  );
}
