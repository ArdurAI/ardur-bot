import type { ComputerStatus, WorkspaceContext, WorkspaceViewId } from "@ardurbot/contracts";
import type { useLingui } from "@lingui/react/macro";
import type { LucideIcon } from "lucide-react";
import { ClipboardList, Folder, Monitor, Repeat, Terminal } from "lucide-react";
import { terminalSupported } from "./terminal-controller";

type Translate = ReturnType<typeof useLingui>["t"];
export type ViewCapabilities = {
  computer: ComputerStatus | null;
  context?: WorkspaceContext | null;
  terminal?: boolean;
};
export type WorkspaceViewDefinition = {
  id: WorkspaceViewId;
  label(t: Translate): string;
  icon: LucideIcon;
  primary?: boolean;
  available(capabilities: ViewCapabilities): boolean;
  unavailable(t: Translate): string;
};

/** One registration point for labels, icons, menus, palette and capability policy. */
export const workspaceViews = {
  tasks: {
    id: "tasks",
    label: (t) => t`Tasks`,
    icon: ClipboardList,
    available: () => true,
    unavailable: (t) => t`Tasks`,
  },
  files: {
    id: "files",
    label: (t) => t`Files`,
    icon: Folder,
    available: ({ computer, context }) =>
      context !== undefined
        ? Boolean(context?.computerId && context.files !== "unavailable")
        : Boolean(
            computer?.computerId &&
              computer.kind !== "fake" &&
              computer.kind !== "desktop" &&
              (computer.state === "running" ||
                (computer.homeRevision && computer.homeRevision !== "empty")),
          ),
    unavailable: (t) => t`Files are unavailable on this computer.`,
  },
  terminal: {
    id: "terminal",
    label: (t) => t`Terminal`,
    icon: Terminal,
    primary: true,
    available: ({ computer, terminal }) => terminal !== false && terminalSupported(computer),
    unavailable: (t) => t`Terminal is unavailable on this computer.`,
  },
  routines: {
    id: "routines",
    label: (t) => t`Routines`,
    icon: Repeat,
    available: () => true,
    unavailable: (t) => t`Routines`,
  },
  screen: {
    id: "screen",
    label: (t) => t`Screen`,
    icon: Monitor,
    primary: true,
    available: ({ computer }) => computer?.capabilities?.graphical === true,
    unavailable: (t) => t`Screen is unavailable on this computer.`,
  },
  computer: {
    id: "computer",
    label: (t) => t`Computer`,
    icon: Monitor,
    available: ({ computer }) => computer?.capabilities?.graphical !== true,
    unavailable: (t) => t`Open Screen to view this computer.`,
  },
} satisfies Record<WorkspaceViewId, WorkspaceViewDefinition>;

export function isWorkspaceViewId(value: unknown): value is WorkspaceViewId {
  return typeof value === "string" && Object.hasOwn(workspaceViews, value);
}
export function availableWorkspaceViews(capabilities: ViewCapabilities): WorkspaceViewDefinition[] {
  return Object.values(workspaceViews).filter((view) => view.available(capabilities));
}
