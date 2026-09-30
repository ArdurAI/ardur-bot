/*
 * Adapted from opencode's scoped layout store and open/closeSessionTab policy:
 * https://github.com/sst/opencode/blob/2fa3363c924c5c3e367b84a87ae478296a0ed59b/packages/app/src/context/layout-tabs.ts
 * https://github.com/sst/opencode/blob/2fa3363c924c5c3e367b84a87ae478296a0ed59b/packages/app/src/context/layout.tsx
 * MIT License — Copyright (c) 2025 opencode
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type { WorkspaceLayout, WorkspaceView, WorkspaceViewId } from "@ardurbot/contracts";
import { useEffect, useState } from "react";
import { isWorkspaceViewId } from "./view-registry";

export function defaultWorkspaceLayout(): WorkspaceLayout {
  return {
    version: 1,
    open: [{ type: "tasks" }, { type: "routines" }],
    active: "tasks",
    visible: false,
    expanded: false,
    position: "right",
    width: 480,
    height: 280,
  };
}
export function workspaceLayoutKey(userId: string, spaceId: string, botId: string): string {
  return `ardurbot:workspace-layout:${JSON.stringify([userId, spaceId, botId])}`;
}

/** Validate untrusted storage and construct only the allowlisted presentation fields. */
export function restoreWorkspaceLayout(value: unknown): WorkspaceLayout {
  const fallback = defaultWorkspaceLayout();
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const saved = value as Record<string, unknown>;
  if (
    saved.version !== 1 ||
    !Array.isArray(saved.open) ||
    saved.open.length > 6 ||
    typeof saved.visible !== "boolean" ||
    typeof saved.expanded !== "boolean" ||
    !["right", "left", "bottom"].includes(String(saved.position)) ||
    typeof saved.width !== "number" ||
    !Number.isFinite(saved.width) ||
    typeof saved.height !== "number" ||
    !Number.isFinite(saved.height)
  )
    return fallback;
  const open: WorkspaceView[] = [];
  for (const item of saved.open) {
    if (!item || typeof item !== "object" || !isWorkspaceViewId(item.type)) return fallback;
    if (!open.some((view) => view.type === item.type)) open.push({ type: item.type });
  }
  if (
    saved.active !== null &&
    (!isWorkspaceViewId(saved.active) || !open.some((view) => view.type === saved.active))
  )
    return fallback;
  if (open.length > 0 && saved.active === null) return fallback;
  return {
    version: 1,
    open,
    active: saved.active as WorkspaceViewId | null,
    visible: open.length > 0 && saved.visible,
    expanded: open.length > 0 && saved.expanded,
    position: saved.position as WorkspaceLayout["position"],
    width: Math.max(360, Math.min(800, Math.round(saved.width))),
    height: Math.max(200, Math.min(600, Math.round(saved.height))),
  };
}
export function readWorkspaceLayout(key: string | null): WorkspaceLayout {
  try {
    return key
      ? restoreWorkspaceLayout(JSON.parse(window.localStorage.getItem(key) ?? "null"))
      : defaultWorkspaceLayout();
  } catch {
    return defaultWorkspaceLayout();
  }
}
export function writeWorkspaceLayout(key: string, layout: WorkspaceLayout): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(restoreWorkspaceLayout(layout)));
  } catch {
    /* Storage is optional. */
  }
}
export function openWorkspaceView(layout: WorkspaceLayout, type: WorkspaceViewId): WorkspaceLayout {
  return {
    ...layout,
    open: layout.open.some((view) => view.type === type) ? layout.open : [...layout.open, { type }],
    active: type,
    visible: true,
  };
}
export function closeWorkspaceView(
  layout: WorkspaceLayout,
  type: WorkspaceViewId,
): WorkspaceLayout {
  const open = layout.open.filter((view) => view.type !== type);
  const index = layout.open.findIndex((view) => view.type === type);
  const active =
    layout.active !== type
      ? layout.active
      : (layout.open[index - 1]?.type ?? layout.open[index + 1]?.type ?? null);
  return {
    ...layout,
    open,
    active,
    visible: open.length > 0 && layout.visible,
    expanded: open.length > 0 && layout.expanded,
  };
}

/** A synchronous scope change prevents painting or saving bot A's layout under bot B. */
export function useWorkspaceLayout(key: string | null) {
  const [stored, setStored] = useState(() => ({ key, layout: readWorkspaceLayout(key) }));
  const current = stored.key === key ? stored : { key, layout: readWorkspaceLayout(key) };
  if (stored.key !== key) setStored(current);
  useEffect(() => {
    if (current.key) writeWorkspaceLayout(current.key, current.layout);
  }, [current.key, current.layout]);
  const update = (change: (layout: WorkspaceLayout) => WorkspaceLayout) => {
    setStored((previous) =>
      previous.key === key ? { key, layout: change(previous.layout) } : previous,
    );
  };
  return { layout: current.layout, update };
}
