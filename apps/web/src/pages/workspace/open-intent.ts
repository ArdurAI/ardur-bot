import type { WorkspaceContext, WorkspaceOpenIntent } from "@ardurbot/contracts";
import { WorkspaceOpenIntentSchema } from "@ardurbot/contracts";

/** Links carry identity, never authority. The API must recheck this binding before opening. */
export function checkedWorkspaceIntent(
  value: unknown,
  botId: string,
  context: WorkspaceContext | null,
): WorkspaceOpenIntent | null {
  const parsed = WorkspaceOpenIntentSchema.safeParse(value);
  if (!parsed.success) return null;
  const intent = parsed.data;
  if (!("target" in intent)) return intent;
  const target = intent.target;
  return context &&
    context.files !== "unavailable" &&
    target.botId === botId &&
    context.botId === botId &&
    target.rootId === context.rootId &&
    target.computerId === context.computerId &&
    target.generation === context.generation
    ? intent
    : null;
}

export function workspaceIntentHref(intent: WorkspaceOpenIntent) {
  return `/app/workspace?intent=${encodeURIComponent(JSON.stringify(intent))}`;
}

export function workspaceFileIntentFromHref(
  href: string,
  context: WorkspaceContext | null,
): unknown {
  if (!context?.rootId || !context.computerId || context.generation === null) return null;
  const match = /^([^?#:]+\.[a-z0-9]+)(?:#L([1-9][0-9]*))?$/i.exec(href);
  if (!match) return null;
  return {
    view: { type: "ide" },
    target: {
      botId: context.botId,
      rootId: context.rootId,
      computerId: context.computerId,
      generation: context.generation,
    },
    path: match[1]!.replace(/^\.\//, ""),
    ...(match[2] ? { line: Number(match[2]) } : {}),
  };
}

export function workspaceIntentFromHref(href: string): unknown {
  try {
    const url = new URL(href, window.location.origin);
    if (url.origin !== window.location.origin || url.pathname !== "/app/workspace") return null;
    return JSON.parse(url.searchParams.get("intent") ?? "null");
  } catch {
    return null;
  }
}
