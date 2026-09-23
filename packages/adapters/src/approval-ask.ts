import type { MessageBlock } from "@ardurbot/contracts";
import { redactSecrets } from "@ardurbot/core";

const MAX_APPROVAL_SUMMARY_LENGTH = 500;
const MAX_APPROVAL_DETAIL_LENGTH = 4_000;

export type IntegrationApprovalAction = {
  vendorName: string;
  toolId: string;
  description: string;
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
): MessageBlock {
  const summary = options?.integration
    ? describeIntegrationAction(options.integration, args)
    : describeApprovalAction(toolName, args);
  const detail = [
    options?.integration
      ? [...new Set([options.integration.toolId, toolName])].join(" · ")
      : undefined,
    formatApprovalDetail(toolName, args, options?.reviewReason),
  ]
    .filter(Boolean)
    .join("\n");
  const safeDetail = detail ? redactSecrets(detail, secrets) : undefined;
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
        secrets,
      ),
      MAX_APPROVAL_SUMMARY_LENGTH,
    ),
    detail: safeDetail ? truncate(safeDetail, MAX_APPROVAL_DETAIL_LENGTH) : undefined,
    status: "pending",
    actions:
      toolName === "create_space"
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
