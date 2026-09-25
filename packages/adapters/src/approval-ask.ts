import type { HostCommandApproval, MessageBlock } from "@ardurbot/contracts";
import { looksLikeChatSecret } from "@ardurbot/contracts";
import { integrationToolKind, redactSecrets } from "@ardurbot/core";
import { shellQuote } from "@ardurbot/core/node/desktop-runtime";

const MAX_APPROVAL_SUMMARY_LENGTH = 500;
const MAX_APPROVAL_DETAIL_LENGTH = 4_000;

export type IntegrationApprovalAction = {
  vendorName: string;
  toolId: string;
  description: string;
  hostCommand?: HostCommandApproval;
  hostCommandRequired?: boolean;
};

export function buildApprovalAskBlock(
  effectId: string,
  toolName: string,
  args: Record<string, unknown>,
  secrets: string[],
  options?: {
    reviewReason?: string;
    allowAlways?: boolean;
    integration?: IntegrationApprovalAction;
  },
): Extract<MessageBlock, { kind: "ask" }> {
  const hidden = [...secrets];
  function collect(value: unknown, depth = 0) {
    if (!value || typeof value !== "object" || depth > 12) return;
    for (const [key, item] of Object.entries(value)) {
      if (
        /secret|password|credential|authorization|(?:^|_)(?:api_?key|token)(?:$|_)/i.test(key) &&
        typeof item === "string" &&
        item
      )
        hidden.push(item);
      else if (typeof item === "object") collect(item, depth + 1);
    }
  }
  collect(args);
  const hostCommand = options?.integration?.hostCommand;
  if (options?.integration?.hostCommandRequired && !hostCommand)
    throw new Error("The command preview is unavailable. Request approval again.");
  if (hostCommand) {
    return {
      kind: "ask",
      approvalEffectId: effectId,
      preformatted: true,
      text: hostCommand.argv
        .map((arg, index, argv) => shellQuote(redactApprovalArgument(arg, hidden, argv[index - 1])))
        .join(" "),
      detail: [
        `Identity: ${redactApprovalText(hostCommand.identity, hidden)}`,
        hostCommand.workspace === null
          ? undefined
          : `Workspace: ${redactApprovalText(hostCommand.workspace, hidden)}`,
        `Working directory: ${shellQuote(redactApprovalText(hostCommand.cwd, hidden))}`,
      ]
        .filter(Boolean)
        .join("\n"),
      status: "pending",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    };
  }
  const arrayDetail = arrayApprovalDetail(args, hidden);
  const integrationWrite =
    options?.integration &&
    (integrationToolKind(options.integration.toolId, options.integration.description) === "write" ||
      Object.entries(args).some(
        ([key, value]) =>
          /^(action|operation|method|command)$/i.test(key) &&
          (typeof value !== "string" || !/^(get|list|search|find|read|fetch)$/i.test(value)),
      ));
  const preview = integrationWrite
    ? integrationWritePreview(options!.integration!, args, hidden)
    : undefined;
  const summary =
    preview?.question ??
    (options?.integration
      ? describeIntegrationAction(options.integration, args)
      : describeApprovalAction(toolName, args));
  const detail = [
    options?.integration
      ? [...new Set([options.integration.toolId, toolName])].join(" · ")
      : undefined,
    preview ? preview.detail : formatApprovalDetail(toolName, args, options?.reviewReason),
    arrayDetail,
  ]
    .filter(Boolean)
    .join("\n");
  const safeDetail = detail ? redactSecrets(detail, hidden) : undefined;
  return {
    kind: "ask",
    approvalEffectId: effectId,
    text: truncate(
      redactSecrets(
        options?.integration
          ? summary
          : toolName === "create_space"
            ? `${summary}?`
            : `Review before ${summary}`,
        hidden,
      ),
      MAX_APPROVAL_SUMMARY_LENGTH,
    ),
    detail: safeDetail
      ? arrayDetail
        ? safeDetail
        : truncate(safeDetail, MAX_APPROVAL_DETAIL_LENGTH)
      : undefined,
    ...(arrayDetail ? { preformatted: true } : {}),
    status: "pending",
    actions: preview
      ? [
          { id: "allow", label: preview.action },
          { id: "deny", label: "Cancel", outcome: "cancelled" },
        ]
      : toolName === "create_space"
        ? [
            { id: "allow", label: "Create space", outcome: "created" },
            { id: "deny", label: "Cancel", outcome: "cancelled" },
          ]
        : [
            { id: "allow", label: "Allow once" },
            ...(options?.allowAlways === false
              ? []
              : [{ id: "always", label: "Always allow this tool" }]),
            { id: "deny", label: "Deny" },
          ],
  };
}

const SECRET_ARGUMENT =
  /password|passwd|secret|token|credential|authorization|cookie|(?:api|access|private|client)[_-]?key/i;

function redactApprovalText(value: string, secrets: string[]): string {
  const redacted = redactSecrets(value, secrets)
    .replace(/Bearer\s+\S+/gi, "[redacted]")
    .replace(
      /(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bsk-[A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
      "[redacted]",
    )
    .replace(
      /([\w-]*(?:password|passwd|secret|token|credential|authorization|cookie|api[_-]?key|access[_-]?key|private[_-]?key)[\w-]*["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}]+)/gi,
      "$1[redacted]",
    )
    .replace(/(https?:\/\/)[^/\s@]+@/gi, "$1[redacted]@");
  return looksLikeChatSecret(redacted.replaceAll("[redacted]", "")) ? "[redacted]" : redacted;
}

function redactApprovalArgument(value: string, secrets: string[], previous?: unknown): string {
  return typeof previous === "string" &&
    /^-/.test(previous) &&
    !previous.includes("=") &&
    SECRET_ARGUMENT.test(previous)
    ? "[redacted]"
    : redactApprovalText(value, secrets);
}

/** Array order, primitive entries and nested payloads are consequential, not summary prose. */
function arrayApprovalDetail(args: Record<string, unknown>, secrets: string[]): string | undefined {
  let hasArray = false;
  const json = JSON.stringify(
    args,
    (key, value) => {
      if (Array.isArray(value)) hasArray = true;
      if (key && SECRET_ARGUMENT.test(key)) return "[redacted]";
      if (Array.isArray(value)) {
        return value.map((item, index) =>
          typeof item === "string" ? redactApprovalArgument(item, secrets, value[index - 1]) : item,
        );
      }
      return typeof value === "string" ? redactApprovalText(value, secrets) : value;
    },
    2,
  );
  return hasArray ? `Arguments:\n${json}` : undefined;
}

function integrationWritePreview(
  integration: IntegrationApprovalAction,
  args: Record<string, unknown>,
  secrets: string[],
) {
  const plain = (value: string) =>
    redactSecrets(value, secrets)
      .replace(/Bearer\s+\S+/gi, "[redacted]")
      .replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, "[redacted]")
      .replace(/<[^>]*>/g, "")
      .replace(/[\\`*_[\]]/g, "")
      .trim();
  const description = plain(integration.description).split(/\n|(?<=[.!?])\s/)[0] || "Write content";
  const action = /^(post|send)\b/i.test(description)
    ? "Post"
    : /^(delete|remove|archive)\b/i.test(description)
      ? "Delete"
      : /^merge\b/i.test(description)
        ? "Merge"
        : "Save";
  const destinations: string[] = [];
  const titles: string[] = [];
  const content: string[] = [];
  let visited = 0;
  function walk(value: unknown, depth = 0, parent = "") {
    if (!value || typeof value !== "object" || depth > 10 || ++visited > 500) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1, parent);
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      if (/secret|token|password|credential|authorization|api.?key/i.test(key)) continue;
      if (typeof item === "string" && item) {
        if (
          /^(parent|parent_id|page_id|pageId|database_id|databaseId|project|projectKey|project_key|space|spaceKey|space_key|channel|channel_id|channelId|to)$/.test(
            key,
          ) ||
          (/^(id|key)$/.test(key) && /parent|project|space|channel/.test(parent))
        )
          destinations.push(plain(item).slice(0, 200));
        if (/^(title|subject|summary)$/.test(key)) titles.push(plain(item).slice(0, 240));
        else if (/^(body|content|text|markdown|new_str)$/.test(key))
          content.push(plain(item).split("\n").slice(0, 6).join("\n").slice(0, 1200));
      } else if (typeof item === "object") walk(item, depth + 1, key);
    }
  }
  walk(args);
  const repo =
    typeof args.owner === "string" && typeof args.repo === "string"
      ? `${args.owner}/${args.repo}`
      : typeof args.repository === "string"
        ? args.repository
        : undefined;
  const number = args.pull_number ?? args.issue_number;
  const reference =
    (typeof number === "number" && Number.isSafeInteger(number) && number > 0) ||
    (typeof number === "string" && /^[1-9][0-9]*$/.test(number))
      ? `#${number}`
      : "";
  if (repo) destinations.unshift(`${repo}${reference}`);
  const target = [...new Set(destinations)].join(", ");
  const channel =
    typeof args.channel === "string" && args.channel.startsWith("#") ? args.channel : undefined;
  return {
    action,
    question:
      action === "Post" && channel
        ? `Post to ${channel}?`
        : action === "Delete"
          ? `Delete this from ${integration.vendorName}?`
          : action === "Merge"
            ? `Merge this on ${integration.vendorName}?`
            : `${action} this to ${integration.vendorName}?`,
    detail: [
      integration.vendorName,
      description,
      target ? `Destination: ${target}` : undefined,
      ...titles.slice(0, 2),
      ...content.slice(0, 3),
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function describeIntegrationAction(
  integration: IntegrationApprovalAction,
  args: Record<string, unknown>,
): string {
  // Manifest prose is display data, never Markdown or instructions for the executor.
  const description =
    integration.description.trim().split(/\n|(?<=[.!?])\s/)[0] ||
    integration.toolId.replace(/[_-]+/g, " ");
  const plain = description
    .replace(/<[^>]*>/g, "")
    .replace(/[\\`*_[\]#]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/, "");
  const action = plain.replace(/^[A-Z](?=[a-z])/, (letter) => letter.toLowerCase());
  const repo =
    typeof args.repo === "string" && typeof args.owner === "string"
      ? `${args.owner}/${args.repo}`
      : typeof args.repository === "string"
        ? args.repository
        : undefined;
  const number = args.pull_number ?? args.issue_number;
  const reference =
    typeof number === "number" && Number.isSafeInteger(number) && number > 0
      ? `#${number}`
      : typeof number === "string" && /^\d+$/.test(number)
        ? `#${number}`
        : "";
  const target = repo ? `${repo}${reference}` : pickScopeLabel(args);
  return `${integration.vendorName} · ${action}${target ? ` on ${target}` : ""}`;
}

function describeApprovalAction(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "destination.write") {
    const collection = args.collection ? String(args.collection) : "records";
    const title = args.title ? ` "${String(args.title)}"` : "";
    return `writing${title} to ${collection}`;
  }
  if (toolName === "delete_bot" || toolName === "archive_bot") {
    const name = args.confirm_name ?? args.confirmName;
    return name ? `${toolName.replace("_", " ")} (${String(name)})` : toolName.replace("_", " ");
  }
  if (toolName === "create_space") {
    const name = args.name ? String(args.name) : "Untitled";
    return `Create space “${name}”`;
  }
  const target = pickScopeLabel(args);
  return target ? `${toolName} → ${target}` : toolName;
}

function formatApprovalDetail(
  toolName: string,
  args: Record<string, unknown>,
  reviewReason?: string,
): string | undefined {
  const lines: string[] = [];
  if (reviewReason?.trim()) {
    lines.push(reviewReason.trim().replace(/\u2014|\u2013/g, "-"));
  }
  if (toolName === "create_space") {
    lines.push(
      "Bots, groups, chats, files, memory, and integrations in this space stay separate from other spaces.",
    );
  }
  for (const key of ["collection", "title", "to", "subject", "amount", "body"]) {
    const value = args[key];
    if (value == null || value === "") continue;
    lines.push(`${key}: ${String(value)}`);
  }
  if (lines.length === 0) return undefined;
  return lines.join("\n");
}

function pickScopeLabel(args: Record<string, unknown>): string | undefined {
  for (const key of ["to", "title", "collection", "subject", "amount"]) {
    const value = args[key];
    if (value != null && value !== "") return String(value);
  }
  return undefined;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}
