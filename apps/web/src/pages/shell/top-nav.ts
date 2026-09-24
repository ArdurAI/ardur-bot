import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useSyncExternalStore } from "react";

export type TopNavItem = {
  id: string;
  label: MessageDescriptor;
  to: string;
  order: number;
  available: boolean | (() => boolean);
};
let items: readonly TopNavItem[] = [];
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => items;

export function registerTopNavItem(item: TopNavItem): () => void {
  items = [...items.filter((entry) => entry.id !== item.id), item].sort(
    (a, b) => a.order - b.order || a.id.localeCompare(b.id),
  );
  for (const listener of listeners) listener();
  return () => {
    items = items.filter((entry) => entry !== item);
    for (const listener of listeners) listener();
  };
}
export function useTopNavItems() {
  return useSyncExternalStore(subscribe, snapshot, snapshot).filter((item) =>
    typeof item.available === "function" ? item.available() : item.available,
  );
}
export function topNavShortcut(
  event: Pick<
    KeyboardEvent,
    "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "repeat" | "isComposing"
  >,
  available: readonly TopNavItem[],
) {
  if (
    !(event.metaKey || event.ctrlKey) ||
    event.altKey ||
    event.shiftKey ||
    event.repeat ||
    event.isComposing
  )
    return undefined;
  const digit = /^Digit[1-4]$/.test(event.code) ? event.code.slice(-1) : event.key;
  return /^[1-4]$/.test(digit) ? available[Number(digit) - 1] : undefined;
}
export function currentTopNavId(pathname: string, available: readonly TopNavItem[]) {
  if (pathname === "/app") return "dashboard";
  const exact = available.find((item) => item.to.split("?")[0] === pathname);
  return exact?.id ?? "bots";
}

registerTopNavItem({
  id: "dashboard",
  label: msg`Dashboard`,
  to: "/app?view=dashboard",
  order: 10,
  available: true,
});
registerTopNavItem({ id: "bots", label: msg`Bots`, to: "/app/bots", order: 20, available: true });
