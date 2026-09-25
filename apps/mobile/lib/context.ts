import { BriefSchema, ContextMetricsSchema, ContextSettingsSchema } from "@ardurbot/contracts";
import { rpc } from "./api";

export async function loadContext(botId: string, groupId?: string) {
  const [briefs, metrics, settings] = await Promise.all([
    rpc("briefs/list", { botId, groupId }),
    rpc("metrics/context", { botId, groupId }),
    rpc("context/settings", { botId }),
  ]);
  return {
    briefs: BriefSchema.array().parse(briefs),
    metrics: ContextMetricsSchema.parse(metrics),
    concurrentRuns: ContextSettingsSchema.parse(settings).concurrentRuns,
  };
}
