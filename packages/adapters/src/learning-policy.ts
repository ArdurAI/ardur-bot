import { isReadPolicyTool } from "@ardurbot/core";

export interface PolicyApproval {
  id: string;
  botId: string;
  tool: string;
  at: Date;
  userId: string;
}
export function policyCandidates(approvals: PolicyApproval[], userId: string, now: Date) {
  const from = new Date(now.getTime() - 14 * 86400000);
  const grouped = new Map<string, PolicyApproval[]>();
  for (const a of approvals) {
    if (a.userId !== userId || a.at < from || a.at >= now || !isReadPolicyTool(a.tool)) continue;
    const key = JSON.stringify([a.botId, a.tool]);
    const values = grouped.get(key) ?? [];
    if (!values.some((v) => v.id === a.id)) values.push(a);
    grouped.set(key, values);
  }
  return [...grouped.values()]
    .filter((values) => values.length >= 5)
    .map((values) => ({
      botId: values[0]!.botId,
      tool: values[0]!.tool,
      count: values.length,
      from,
      to: now,
    }));
}
export function policySuppressed(rejectedAt: Date | null | undefined, now: Date) {
  return !!rejectedAt && rejectedAt.getTime() + 30 * 86400000 > now.getTime();
}
