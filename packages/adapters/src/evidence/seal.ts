import type { EvidenceStore, PrismaClient } from "@ardurbot/db";
import {
  boundDirectApprovalDetails,
  CATALOG_APPROVAL_TOOL,
  catalogApprovalDetails,
  catalogApprovalInnerArgs,
} from "../approval-effect.js";
import { builtinAgentTools } from "../builtin-tools.js";
import type { EvidenceRecorder, EvidenceResult } from "./recorder.js";

const builtinNames = new Set(builtinAgentTools.map((tool) => tool.name));

export function createEvidenceSealer(deps: {
  prisma: PrismaClient;
  store: EvidenceStore;
  recorder: EvidenceRecorder;
}) {
  return async (runId: string): Promise<EvidenceResult> => {
    try {
      if (!(await deps.store.sealForRun(runId))) {
        const records = await deps.store.recordsForRun(runId);
        for (const asked of records.filter((row) => row.decisionKind === "asked")) {
          const prefix = `evidence:${runId}:effect:`;
          if (!asked.id.startsWith(prefix) || !asked.id.endsWith(":asked"))
            throw new Error("Missing approval evidence binding");
          const effectId = asked.id.slice(prefix.length, -":asked".length);
          const callPrefix = `${prefix}${effectId}:`;
          if (
            records.some(
              (row) =>
                row.seq > asked.seq &&
                row.id.startsWith(callPrefix) &&
                row.decisionKind !== "asked",
            )
          )
            continue;
          const run = await deps.prisma.run.findUniqueOrThrow({ where: { id: runId } });
          const effect = await deps.prisma.externalEffect.findUnique({ where: { id: effectId } });
          if (effect && effect.runId !== runId) throw new Error("Approval run mismatch");
          const binding = await deps.prisma.deviceApprovalBinding.findUnique({
            where: { effectId },
          });
          const decisionKind =
            effect?.status === "denied" || effect?.decision === "deny"
              ? "denied_by_owner"
              : binding && binding.expiresAt <= new Date()
                ? "approval_expired"
                : "unanswered_at_run_end";
          const bound = boundDirectApprovalDetails(effect?.request, CATALOG_APPROVAL_TOOL);
          const catalog = catalogApprovalDetails(effect?.request, CATALOG_APPROVAL_TOOL);
          const result = await deps.recorder.recordDecision({
            run,
            toolName: asked.toolName,
            viaConnector: !builtinNames.has(asked.toolName),
            args: bound?.args ?? (catalog ? catalogApprovalInnerArgs(catalog) : effect?.request),
            decisionKind,
            decisionId: `effect:${effectId}:${decisionKind}`,
          });
          if (!result.ok) return result;
        }
      }
      return deps.recorder.sealRunEvidence(runId);
    } catch {
      return { ok: false, reason: "sealing_failed" };
    }
  };
}
