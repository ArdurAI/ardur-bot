import type {
  ChiefControl,
  ChiefCorrection,
  ChiefDecision,
  ChiefMemberFacts,
  ChiefOperation,
  ChiefReceiptKey,
  TaskType,
} from "@ardurbot/contracts";

export const CHIEF_POLICY_VERSION = 1;
export const CHIEF_RECONCILIATION_POLICY: Readonly<{ orphanOutcomeAfterMs: number }> = {
  // Five minutes lets late receipts settle. A missing/terminal run with no live lease
  // cannot verify forever; retain unknown (never permission to repeat its effect).
  orphanOutcomeAfterMs: 5 * 60_000,
};
/** Add templates here; surfaces translate these keys, never classify owner text. */
export const CHIEF_RECEIPT_TEMPLATES: Readonly<Record<ChiefReceiptKey, string>> = {
  "document-to-service": "Got it — I’ll choose a team member to put this in Notion.",
  "install-tool": "Got it — I’ll check what’s missing and ask before installing it.",
  general: "Got it — I’ll check the request and choose the next step.",
  greeting: "Hi everyone.",
  "exclude-member": "Got it — I’ll keep X off this task.",
  "change-task": "Got it — I’ll check this change before the next action.",
};

type RankingKey = "skill" | "role" | "slot" | "active" | "queued" | "id";
export type ChiefRule = {
  operation: ChiefOperation;
  requires: readonly string[];
  effect: "read-only" | "approval-required";
  preferredSkills: readonly string[];
  preferredRoles: readonly string[];
  ranking: readonly RankingKey[];
  onNoMatch: "queue" | "prepare-and-ask" | "chief-plan";
  receipt: ChiefReceiptKey;
};
const ranking: readonly RankingKey[] = ["skill", "role", "slot", "active", "queued", "id"];
const general = (taskType: TaskType): ChiefRule => ({
  operation: { taskType, purpose: "general" },
  requires: [],
  effect: "read-only",
  preferredSkills: [taskType],
  preferredRoles: [taskType],
  ranking,
  onNoMatch: "chief-plan",
  receipt: "general",
});
/** Complete coverage. General work still goes through the chief's pinned planning turn. */
export const CHIEF_TASK_RULES: Readonly<Record<TaskType, ChiefRule>> = {
  "small-talk": general("small-talk"),
  "simple-question": general("simple-question"),
  writing: general("writing"),
  summary: general("summary"),
  "code-change": general("code-change"),
  debugging: general("debugging"),
  review: general("review"),
  planning: general("planning"),
  research: general("research"),
  data: general("data"),
  operations: general("operations"),
  unknown: general("unknown"),
};
/** Existing saved descriptors are preferences, not a new skill taxonomy or grants. */
export const CHIEF_OPERATION_RULES: readonly ChiefRule[] = [
  {
    operation: { taskType: "operations", purpose: "document-to-service" },
    requires: ["notion:read-back"],
    effect: "approval-required",
    preferredSkills: ["document", "publishing", "notion"],
    preferredRoles: ["documentation", "operations"],
    ranking,
    onNoMatch: "chief-plan",
    receipt: "document-to-service",
  },
  {
    operation: { taskType: "operations", purpose: "install-tool" },
    requires: ["computer:package-preparation"],
    effect: "approval-required",
    preferredSkills: ["installation", "runbook"],
    preferredRoles: ["operations"],
    ranking,
    onNoMatch: "chief-plan",
    receipt: "install-tool",
  },
];
export function chiefRule(operation: ChiefOperation): ChiefRule {
  return (
    CHIEF_OPERATION_RULES.find((row) => row.operation.purpose === operation.purpose) ??
    CHIEF_TASK_RULES[operation.taskType]
  );
}

/** Strict, bounded owner-command envelopes, not document instructions or authorization. */
const INTENT_TEMPLATES: readonly {
  key: ChiefReceiptKey;
  purpose: ChiefOperation["purpose"];
  pattern: RegExp;
}[] = [
  { key: "greeting", purpose: "general", pattern: /^(?:hi|hello|hey)(?:\s+everyone)?[.!]?$/iu },
  {
    key: "document-to-service",
    purpose: "document-to-service",
    pattern:
      /^(?:please\s+)?(?:put|upload|add|send)\s+(?:this|the)(?:\s+long)?\s+document\s+(?:in|to|into)\s+notion[.!]?$/iu,
  },
  {
    key: "install-tool",
    purpose: "install-tool",
    pattern: /^(?:please\s+)?install\s+(?:the\s+)?(?:missing\s+)?tool[.!]?$/iu,
  },
];
export const CHIEF_INDIVIDUAL_REPLY_RULES: readonly RegExp[] = [
  /^everyone,?\s+each of you\s+(?:say hello|reply|answer)[.!]?$/iu,
];
export function chiefWantsIndividualReplies(text: string): boolean {
  return text.length <= 200 && CHIEF_INDIVIDUAL_REPLY_RULES.some((rule) => rule.test(text.trim()));
}
export function chiefIntent(input: {
  text: string;
  taskType: TaskType;
  hasAttachments?: boolean;
  hasContextReferences?: boolean;
  reply?: boolean;
}): { key: ChiefReceiptKey; operation: ChiefOperation; receiptOnly: boolean } {
  const text = input.text.trim();
  const row =
    text.length <= 800 ? INTENT_TEMPLATES.find((entry) => entry.pattern.test(text)) : undefined;
  const greeting =
    row?.key === "greeting" && !input.hasAttachments && !input.hasContextReferences && !input.reply;
  const key =
    row?.key === "greeting" ? (greeting ? "greeting" : "general") : (row?.key ?? "general");
  return {
    key,
    operation: {
      taskType: row && row.key !== "greeting" ? "operations" : input.taskType,
      purpose: row?.purpose ?? "general",
    },
    receiptOnly: greeting,
  };
}

export function chooseChiefMember(input: {
  chiefId: string;
  operation: ChiefOperation;
  members: readonly ChiefMemberFacts[];
  excludedIds?: readonly string[];
  explicitMemberId?: string;
  requiredComputerId?: string;
}): ChiefDecision {
  if (input.operation.purpose === "general") return { kind: "plan" };
  const rule = chiefRule(input.operation);
  const eligible = input.members.filter(
    (member) =>
      member.authorized &&
      member.runtimeSupported &&
      member.inputAccess === "known" &&
      !input.excludedIds?.includes(member.id) &&
      member.computer?.local &&
      (!input.requiredComputerId || member.computer.id === input.requiredComputerId) &&
      (input.operation.purpose !== "install-tool" || Boolean(input.requiredComputerId)) &&
      rule.requires.every((capability) =>
        member.capabilities.some((fact) => fact.id === capability && fact.access === "known"),
      ),
  );
  const ready = (member: ChiefMemberFacts) =>
    member.activeRuns < member.runLimit && !member.computer?.leaseBusy;
  const match = (values: readonly string[], preferences: readonly string[]) =>
    preferences.some((preferred) =>
      values.some((value) => value.toLowerCase().includes(preferred)),
    );
  const score = (member: ChiefMemberFacts, key: RankingKey): number | string => {
    switch (key) {
      case "skill":
        return match(
          member.skills.map((skill) => skill.descriptor),
          rule.preferredSkills,
        )
          ? 0
          : 1;
      case "role":
        return match([member.role], rule.preferredRoles) ? 0 : 1;
      case "slot":
        return ready(member) ? 0 : 1;
      case "active":
        return member.activeRuns;
      case "queued":
        return member.queuedRuns;
      case "id":
        return member.id;
    }
  };
  eligible.sort((a, b) => {
    if (input.explicitMemberId) {
      const explicit =
        Number(b.id === input.explicitMemberId) - Number(a.id === input.explicitMemberId);
      if (explicit) return explicit;
    }
    for (const key of rule.ranking) {
      const av = score(a, key),
        bv = score(b, key);
      const comparison =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv));
      if (comparison) return comparison;
    }
    return 0;
  });
  // An equally skilled/role-fit ready member is preferred to queueing the busy one.
  const best = eligible[0];
  if (!best) return { kind: "plan" };
  if (best.id === input.chiefId) return { kind: "self" };
  return {
    kind: ready(best) ? "delegate" : "queue",
    memberId: best.id,
    reason: `${input.operation.purpose}: saved capability, skill, role and capacity`,
  };
}

/** Whole command envelopes only. A pasted document or positive address is not control. */
export function parseChiefCorrection(input: {
  text: string;
  members: readonly { id: string; name: string }[];
}): ChiefCorrection | undefined {
  const text = input.text.trim();
  if (!text || text.length > 400 || /[\r\n]/u.test(text)) return undefined;
  const exclusion =
    /^(?:please\s+)?(?:don['’]?t|do not|never)\s+(?:send(?:\s+(?:it|this|the document))?\s+to|use|delegate(?:\s+(?:it|this))?\s+to)\s+(.+?)[.!]?$/iu.exec(
      text,
    );
  const standDown = /^(?:please\s+)?(?:stop|stand down)\s+(.+?)[.!]?$/iu.exec(text);
  const name = (exclusion?.[1] ?? standDown?.[1])?.replace(/^@/u, "").toLocaleLowerCase();
  if (name) {
    const matches = input.members.filter((member) => member.name.toLocaleLowerCase() === name);
    if (matches.length === 1)
      return { kind: "exclude", memberId: matches[0]!.id, memberName: matches[0]!.name };
    if (exclusion) return { kind: "replan" };
  }
  if (
    /^(?:please\s+)?(?:keep it local(?: instead)?|don['’]?t upload(?: it)?|do not upload(?: it)?)[.!]?$/iu.test(
      text,
    )
  )
    return { kind: "local-only" };
  if (/^(?:please\s+)?(?:stop|cancel)(?:\s+(?:this|the)\s+task)?[.!]?$/iu.test(text))
    return { kind: "stop" };
  if (
    /^(?:actually[, ]|instead[, ]|change (?:this|the) task|send it (?:to|into) |put it (?:in|into) )/iu.test(
      text,
    )
  )
    return { kind: "replan" };
  return undefined;
}

/** Replay is a no-op; every new owner correction is retained even when planning coalesces. */
export function reviseChiefControl(input: {
  previous?: ChiefControl;
  revision: number;
  ownerMessageId: string;
  correction: ChiefCorrection;
  affectedRunIds: readonly string[];
  uncertainRunIds?: readonly string[];
}): ChiefControl {
  const previous = input.previous;
  if (previous?.ownerMessageIds.includes(input.ownerMessageId)) return previous;
  const unique = (ids: readonly string[]) => [...new Set(ids)];
  return {
    ...(previous?.uncertaintySince ? { uncertaintySince: previous.uncertaintySince } : {}),
    ...(previous?.reconciledActions ? { reconciledActions: previous.reconciledActions } : {}),
    revision: input.revision + 1,
    ownerMessageIds: [...(previous?.ownerMessageIds ?? []), input.ownerMessageId],
    excludedIds: unique([
      ...(previous?.excludedIds ?? []),
      ...(input.correction.kind === "exclude" ? [input.correction.memberId] : []),
    ]),
    localOnly: Boolean(previous?.localOnly || input.correction.kind === "local-only"),
    stopped: Boolean(previous?.stopped || input.correction.kind === "stop"),
    pendingReplan: input.correction.kind !== "stop" && !previous?.stopped,
    stoppingRunIds: unique([...(previous?.stoppingRunIds ?? []), ...input.affectedRunIds]),
    uncertainRunIds: unique([
      ...(previous?.uncertainRunIds ?? []),
      ...(input.uncertainRunIds ?? []),
    ]),
  };
}

export function chiefControlAllowsDispatch(control: ChiefControl | undefined): boolean {
  return (
    !control ||
    (!control.stopped && !control.stoppingRunIds.length && !control.uncertainRunIds.length)
  );
}
