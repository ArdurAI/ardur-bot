import type {
  ChiefActivity,
  ChiefActivityKey,
  ChiefDispatch,
  ChiefResult,
} from "@ardurbot/contracts";

export type ChiefToolIdentity = {
  name: string;
  /** Adapter-owned capability metadata, never tool arguments or descriptions. */
  capability?: "notion-connect" | "notion-write" | "notion-read-back" | "package-check";
};
export type ChiefActivityRule = {
  tools: readonly string[];
  capability?: ChiefToolIdentity["capability"];
  activity: ChiefActivityKey;
};
/** One place to add mappings. Unknown tools (including shell) stay deliberately opaque. */
export const CHIEF_ACTIVITY_RULES: readonly ChiefActivityRule[] = [
  { tools: ["read_file"], activity: "read-input" },
  { tools: [], capability: "notion-connect", activity: "connect-notion" },
  { tools: [], capability: "notion-write", activity: "write-notion" },
  { tools: [], capability: "notion-read-back", activity: "verify-notion" },
  { tools: [], capability: "package-check", activity: "check-tool" },
];
export const CHIEF_ACTIVITY_TEXT: Readonly<Record<ChiefActivityKey, string>> = {
  "read-input": "Reading the document",
  "connect-notion": "Connecting to Notion",
  "write-notion": "Creating the Notion page",
  "verify-notion": "Checking the Notion page",
  "check-tool": "Checking the missing tool",
  working: "Working on the task",
  "waiting-tool": "Waiting for the tool",
};
export function chiefToolActivity(tool: ChiefToolIdentity): ChiefActivityKey {
  return (
    CHIEF_ACTIVITY_RULES.find((row) =>
      row.capability ? row.capability === tool.capability : row.tools.includes(tool.name),
    )?.activity ?? "working"
  );
}
export const CHIEF_ACTIVITY_COALESCE_MS = 500;
export const CHIEF_TOOL_STALE_MS = 15_000;

export function chiefActivityShouldPublish(
  previous: ChiefActivity | undefined,
  next: ChiefActivity,
): boolean {
  return (
    !previous ||
    previous.attempt !== next.attempt ||
    previous.state !== next.state ||
    previous.key !== next.key ||
    Date.parse(next.updatedAt) - Date.parse(previous.updatedAt) >= CHIEF_ACTIVITY_COALESCE_MS
  );
}
export function staleChiefActivity(activity: ChiefActivity, now: Date): ChiefActivity | undefined {
  if (
    activity.state !== "active" ||
    activity.key === "waiting-tool" ||
    now.getTime() - Date.parse(activity.updatedAt) < CHIEF_TOOL_STALE_MS
  )
    return undefined;
  return {
    ...activity,
    key: "waiting-tool",
    sourceSeq: activity.sourceSeq + 1,
    updatedAt: now.toISOString(),
  };
}

/** Reject old revisions/runs/attempts and replayed source cursors. Terminals win. */
export function withChiefActivity(dispatch: ChiefDispatch, next: ChiefActivity): ChiefDispatch {
  if (
    dispatch.revision !== next.revision ||
    dispatch.runId !== next.runId ||
    dispatch.delegationId !== next.delegationId
  )
    return dispatch;
  const previous = dispatch.activity;
  if (previous) {
    if (
      next.attempt < previous.attempt ||
      (next.attempt === previous.attempt && next.sourceSeq <= previous.sourceSeq)
    )
      return dispatch;
    if (
      previous.state !== "active" &&
      previous.state !== "idle" &&
      next.attempt === previous.attempt
    )
      return dispatch;
  }
  return { ...dispatch, activity: next };
}
export function chiefActivityKey(dispatch: ChiefDispatch): ChiefActivityKey | undefined {
  if (dispatch.state === "approval-held") return undefined;
  const activity = dispatch.activity;
  if (!activity) return dispatch.state === "messaged" ? "working" : undefined;
  return activity.state === "active" || activity.state === "idle" ? activity.key : undefined;
}

/** Only a bound independent read-back can turn a draft into success; worker reports cannot. */
export function chiefResult(input: {
  requestMessageId: string;
  revision: number;
  artifactId: string;
  href: string;
  verification?: {
    verdict: "pass" | "fail" | "unknown";
    independent: boolean;
    artifactId: string;
    revision: number;
    destination: string;
    contentDigest: string;
    expectedContentDigest: string;
    effectReceiptId: string;
    pendingEffects: boolean;
  };
}): ChiefResult | undefined {
  // Public service links or scoped internal artifact routes only; no credentials or private URLs.
  const artifactRoute = `/api/artifacts/${encodeURIComponent(input.artifactId)}`;
  let safe = input.href === artifactRoute;
  try {
    const url = new URL(input.href);
    safe ||=
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (url.hostname === "www.notion.so" || url.hostname === "notion.so") &&
      !url.search &&
      !url.hash;
  } catch {
    /* Relative artifact routes are validated above. */
  }
  if (!safe) return undefined;
  const v = input.verification;
  const pass = Boolean(
    v &&
      v.verdict === "pass" &&
      v.independent &&
      v.artifactId === input.artifactId &&
      v.revision === input.revision &&
      v.destination === input.href &&
      v.contentDigest &&
      v.contentDigest === v.expectedContentDigest &&
      v.effectReceiptId &&
      !v.pendingEffects,
  );
  return {
    requestMessageId: input.requestMessageId,
    revision: input.revision,
    artifactId: input.artifactId,
    href: input.href,
    state: pass ? "verified-notion" : "draft",
  };
}
