import * as z from "zod";

/**
 * The one typed table of run and handoff failure categories. A failure is stored as a
 * category id plus its parameters (bot, runtime, member); the English sentence here is the
 * default each app translates through its own catalogs. Adding a category is one entry here
 * plus a translation in each catalog — see docs/failure-categories.md.
 */
export const FailureCategoryIdSchema = z.enum([
  "usage-limit",
  "signed-out",
  "max-turns",
  "model-unavailable",
  "configuration-invalid",
  "connection-missing",
  "stopped",
  "other",
]);
export type FailureCategoryId = z.infer<typeof FailureCategoryIdSchema>;

/** What the failed run or handoff offers next. */
export type FailureCategoryAction =
  | { kind: "none" }
  | { kind: "retry" }
  | { kind: "connect" }
  | { kind: "open-settings"; target: "model-pin" | "group-model" };

/** Named placeholders a category sentence may use. */
export type FailureCategoryParams = {
  bot?: string;
  runtime?: string;
  member?: string;
};

export type FailureCategory = {
  id: FailureCategoryId;
  /** Default English sentence; {bot}, {runtime} and {member} are the named placeholders. */
  message: string;
  /** Group-model sentence, when a group pin can fail this way ({bot}). */
  groupMessage?: string;
  /** Handoff sentence, when a handoff can end this way ({member}). */
  memberMessage?: string;
  action: FailureCategoryAction;
  /**
   * Sentences older builds stored verbatim, as templates with the same named
   * placeholders. Readers map stored English text back to this id through them.
   */
  legacy: readonly string[];
};

export const FAILURE_CATEGORIES: readonly FailureCategory[] = [
  {
    id: "usage-limit",
    message: "{runtime}'s usage limit is reached. Try again after it resets.",
    groupMessage:
      "{bot} hit the group model's usage limit. Try again after it resets, or change the group model.",
    action: { kind: "retry" },
    legacy: [],
  },
  {
    id: "signed-out",
    message: "Sign in to {runtime} on this computer, then try again.",
    groupMessage:
      "{bot}'s sign-in for the group model expired. Reconnect it or change the group model.",
    action: { kind: "connect" },
    legacy: [],
  },
  {
    id: "max-turns",
    message: "{runtime} reached this run's turn limit. Narrow the task and try again.",
    action: { kind: "retry" },
    legacy: [],
  },
  {
    id: "model-unavailable",
    message: "{runtime}'s pinned model is unavailable. Change the pin and try again.",
    action: { kind: "open-settings", target: "model-pin" },
    legacy: [],
  },
  {
    id: "configuration-invalid",
    message: "{runtime}'s configuration is invalid. Check this bot's settings.",
    groupMessage:
      "{bot} couldn't use the model set for this group. Change the group model or check this bot's settings.",
    action: { kind: "open-settings", target: "model-pin" },
    legacy: [],
  },
  {
    id: "connection-missing",
    message: "{runtime}'s model connection is missing. Connect it or change the pin.",
    groupMessage:
      "{bot} couldn't use the model set for this group. Reconnect it or change the group model.",
    action: { kind: "connect" },
    legacy: [],
  },
  {
    id: "stopped",
    message: "{runtime} stopped before finishing this run.",
    memberMessage: "{member} stopped.",
    action: { kind: "none" },
    legacy: ["Worker stopped."],
  },
  {
    id: "other",
    message: "{runtime} could not finish this run. Check the runtime or change the pin.",
    memberMessage: "{member} failed.",
    action: { kind: "none" },
    legacy: ["{runtime} could not finish this run — connect it or change the pin."],
  },
];

export function failureCategory(id: FailureCategoryId): FailureCategory {
  const entry = FAILURE_CATEGORIES.find((category) => category.id === id);
  if (!entry) throw new Error(`Unknown failure category: ${id}`);
  return entry;
}

/** Fill a category template's named placeholders; unfilled placeholders stay readable. */
export function fillFailureCategoryMessage(
  template: string,
  params: FailureCategoryParams,
): string {
  return template.replace(/\{(bot|runtime|member)\}/g, (match, key: string) => {
    const value = params[key as keyof FailureCategoryParams];
    return value ?? match;
  });
}

/** A category's default English sentence with the parameters filled in. */
export function failureCategoryMessage(
  id: FailureCategoryId,
  params: FailureCategoryParams = {},
): string {
  return fillFailureCategoryMessage(failureCategory(id).message, params);
}

/** A category's group-model sentence (falling back to its default) with parameters filled. */
export function failureCategoryGroupMessage(
  id: FailureCategoryId,
  params: FailureCategoryParams = {},
): string {
  const entry = failureCategory(id);
  return fillFailureCategoryMessage(entry.groupMessage ?? entry.message, params);
}

/** A category's handoff sentence (falling back to its default) with parameters filled. */
export function failureCategoryMemberMessage(
  id: FailureCategoryId,
  params: FailureCategoryParams = {},
): string {
  const entry = failureCategory(id);
  return fillFailureCategoryMessage(entry.memberMessage ?? entry.message, params);
}

/**
 * A captured name is a name: short, on one line, and with no sentence or clause ending
 * inside it. Text in front of a category sentence ("Retrying after: Claude Code's usage
 * limit…") is a different reason, which keeps its own words.
 */
function plausibleName(value: string): boolean {
  return value.length <= 80 && !/[\n\r]|[:;.!?]\s/.test(value);
}

function templateToPattern(template: string): RegExp {
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const source = escaped.replace(
    /\\?\{(bot|runtime|member)\\?\}/g,
    (_, name: string) =>
      // Each placeholder captures its value back for the reader. Greedy is safe: the
      // surrounding literals anchor the match and names never contain sentence stops.
      `(?<${name}>.+?)`,
  );
  return new RegExp(`^${source}$`);
}

/**
 * Map a stored English sentence back to its category and captured parameters. Older
 * records hold the sentence verbatim; anything unknown returns undefined so the caller
 * shows its generic line.
 *
 * The handoff lines ("{member} failed.", "{member} stopped.") are not matched here. They
 * are too short to tell from a recorded reason that ends the same way ("npm test
 * failed."), and a recorded reason must keep its own words. A handoff line is recognised
 * by failureCategoryFromMemberLine, which needs the member's name.
 */
export function failureCategoryFromText(
  text: string,
  known: { runtimes?: readonly string[] } = {},
): ({ id: FailureCategoryId } & { params: FailureCategoryParams }) | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  for (const entry of FAILURE_CATEGORIES) {
    const templates = [
      entry.message,
      ...(entry.groupMessage ? [entry.groupMessage] : []),
      ...entry.legacy,
    ];
    for (const template of templates) {
      const match = templateToPattern(template).exec(trimmed);
      if (!match) continue;
      const groups = match.groups ?? {};
      if (!Object.values(groups).every((value) => value === undefined || plausibleName(value)))
        continue;
      // Where the caller knows the runtimes' names, the sentence must name one of them.
      if (groups.runtime && known.runtimes && !known.runtimes.includes(groups.runtime)) continue;
      return {
        id: entry.id,
        params: {
          ...(groups.bot ? { bot: groups.bot } : {}),
          ...(groups.runtime ? { runtime: groups.runtime } : {}),
          ...(groups.member ? { member: groups.member } : {}),
        },
      };
    }
  }
  return undefined;
}

/**
 * The category of a handoff line written for this member ("Reviewer failed."), or
 * undefined for any other text. The line says that a handoff ended, never why, so a
 * reader that finds one has no recorded reason to show.
 */
export function failureCategoryFromMemberLine(
  text: string,
  member: string,
): FailureCategoryId | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  for (const entry of FAILURE_CATEGORIES) {
    if (!entry.memberMessage) continue;
    const lines = [fillFailureCategoryMessage(entry.memberMessage, { member }), ...entry.legacy];
    if (lines.includes(trimmed)) return entry.id;
  }
  return undefined;
}
