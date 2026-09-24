import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { ComponentType, ReactNode } from "react";
import { createElement, useSyncExternalStore } from "react";
import type { SettingsSection } from "../SettingsOverlay";

export type PanelContext = { spaceId: string; signal: AbortSignal };
export type PanelActions = {
  refresh: () => Promise<void>;
  openSettings: (section: SettingsSection | "messaging" | "mcp") => void;
  openLearning: () => void;
};
export type PanelModule<T> = {
  load: (context: PanelContext) => Promise<T | null>;
  default: ComponentType<{ data: T } & PanelActions>;
};
type PanelRegistration<T> = {
  id: string;
  title: MessageDescriptor;
  order: number;
  group: string;
  load: (context: PanelContext) => Promise<T | null>;
  Render: ComponentType<{ data: T } & PanelActions>;
  empty: MessageDescriptor;
};
export type DashboardPanel = Omit<PanelRegistration<unknown>, "Render"> & {
  render: (data: unknown, actions: PanelActions) => ReactNode;
};
let panels: readonly DashboardPanel[] = [];
const listeners = new Set<() => void>();
export const getDashboardPanels = () => panels;
const snapshot = getDashboardPanels;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function registerDashboardPanel<T>(panel: PanelRegistration<T>) {
  const entry: DashboardPanel = {
    ...panel,
    render: (data, actions) => createElement(panel.Render, { data: data as T, ...actions }),
  };
  panels = [...panels.filter((item) => item.id !== panel.id), entry].sort(
    (a, b) => a.order - b.order || a.id.localeCompare(b.id),
  );
  for (const listener of listeners) listener();
  return () => {
    panels = panels.filter((item) => item !== entry);
    for (const listener of listeners) listener();
  };
}
export function useDashboardPanels() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

function lazyPanel<T>(
  id: string,
  title: MessageDescriptor,
  order: number,
  group: string,
  empty: MessageDescriptor,
  chunk: () => Promise<PanelModule<T>>,
) {
  // Import failures use the same retry path as data failures. Successful modules
  // and data stay together in the cache, so a warm render never waits on import().
  registerDashboardPanel({
    id,
    title,
    order,
    group,
    empty,
    load: async (context) => {
      const module = await chunk();
      const value = await module.load(context);
      return value === null ? null : { value, Render: module.default };
    },
    Render: ({ data, ...actions }) => createElement(data.Render, { data: data.value, ...actions }),
  });
}

lazyPanel("now", msg`Now`, 10, "now", msg`Nothing running`, () => import("./NowPanel"));
lazyPanel(
  "computers",
  msg`Computers`,
  20,
  "resources",
  msg`No computers`,
  () => import("./ComputersPanel"),
);
lazyPanel(
  "connections",
  msg`Connections`,
  30,
  "resources",
  msg`No connections`,
  () => import("./ConnectionsPanel"),
);
lazyPanel(
  "routines",
  msg`Routines`,
  40,
  "activity",
  msg`No scheduled runs`,
  () => import("./RoutinesPanel"),
);
lazyPanel("usage", msg`Usage`, 50, "activity", msg`No usage`, () => import("./UsagePanel"));
lazyPanel(
  "learning",
  msg`Learning`,
  60,
  "activity",
  msg`No proposals`,
  () => import("./LearningPanel"),
);
lazyPanel(
  "governance",
  msg`Governance`,
  70,
  "governance",
  msg`Governance and encryption are not part of this build yet.`,
  () => import("./GovernancePanel"),
);
