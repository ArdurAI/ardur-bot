import type { ComputerStatus, WorkspaceContext, WorkspaceViewId } from "@ardurbot/contracts";
import { msg } from "@lingui/core/macro";
import type { useLingui } from "@lingui/react/macro";
import type { LucideIcon } from "lucide-react";
import { ClipboardList, Folder, Monitor, Repeat, Terminal } from "lucide-react";
import type { ReactNode } from "react";
import { createElement, lazy } from "react";
import { terminalSupported } from "./terminal-controller";
import type { WorkspacePaneProps } from "./WorkspacePane";

const Tasks = lazy(() =>
  import("./WorkspaceTasks").then((module) => ({ default: module.WorkspaceTasks })),
);
const Files = lazy(() =>
  import("./WorkspaceFiles").then((module) => ({ default: module.WorkspaceFiles })),
);
const Screen = lazy(() =>
  import("./WorkspaceScreen").then((module) => ({ default: module.WorkspaceScreen })),
);
const TerminalView = lazy(() =>
  import("./WorkspaceTerminal").then((module) => ({ default: module.WorkspaceTerminal })),
);
type ViewBodyProps = Pick<
  WorkspacePaneProps,
  "bot" | "computer" | "routines" | "screen" | "terminal" | "onOpenRun"
> & {
  context: WorkspaceContext | null;
  visible: boolean;
  controlsHost: HTMLElement | null;
  compact: boolean;
};

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
  render(props: ViewBodyProps): ReactNode;
};

/** One registration point for labels, icons, menus, palette and capability policy. */
export const workspaceViews = {
  tasks: {
    id: "tasks",
    label: (t) => t(msg`Tasks`),
    icon: ClipboardList,
    available: () => true,
    unavailable: (t) => t(msg`Tasks`),
    render: ({ bot, visible, onOpenRun }) =>
      createElement(Tasks, { key: bot.id, botId: bot.id, visible, onOpenRun }),
  },
  files: {
    id: "files",
    label: (t) => t(msg`Files`),
    icon: Folder,
    available: ({ context }) => Boolean(context?.computerId && context.files !== "unavailable"),
    unavailable: (t) => t(msg`Files are unavailable on this computer.`),
    render: ({ bot, context, compact }) =>
      context ? createElement(Files, { bot, context, compact }) : null,
  },
  terminal: {
    id: "terminal",
    label: (t) => t(msg`Terminal`),
    icon: Terminal,
    primary: true,
    available: ({ computer, terminal }) => terminal !== false && terminalSupported(computer),
    unavailable: (t) => t(msg`Terminal is unavailable on this computer.`),
    render: ({ bot, computer, visible, terminal, controlsHost }) =>
      terminal
        ? createElement(TerminalView, {
            key: bot.id,
            bot,
            computer,
            visible,
            ...terminal,
            controlsHost,
          })
        : null,
  },
  routines: {
    id: "routines",
    label: (t) => t(msg`Routines`),
    icon: Repeat,
    available: () => true,
    unavailable: (t) => t(msg`Routines`),
    render: ({ routines }) => routines,
  },
  screen: {
    id: "screen",
    label: (t) => t(msg`Screen`),
    icon: Monitor,
    primary: true,
    available: ({ computer }) => computer?.capabilities?.graphical === true,
    unavailable: (t) => t(msg`Screen is unavailable on this computer.`),
    render: ({ screen, visible }) => createElement(Screen, { ...screen, visible }),
  },
  computer: {
    id: "computer",
    primary: true,
    label: (t) => t(msg`Computer`),
    icon: Monitor,
    available: ({ computer }) => computer?.capabilities?.graphical !== true,
    unavailable: (t) => t(msg`Open Screen to view this computer.`),
    render: ({ screen, visible }) => createElement(Screen, { ...screen, visible }),
  },
} satisfies Record<WorkspaceViewId, WorkspaceViewDefinition>;

export function isWorkspaceViewId(value: unknown): value is WorkspaceViewId {
  return typeof value === "string" && Object.hasOwn(workspaceViews, value);
}
export function availableWorkspaceViews(capabilities: ViewCapabilities): WorkspaceViewDefinition[] {
  return Object.values(workspaceViews).filter((view) => view.available(capabilities));
}
