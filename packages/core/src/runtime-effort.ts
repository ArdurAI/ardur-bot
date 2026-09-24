import type { Bot, RuntimeInfo, RuntimePin } from "@ardurbot/contracts";

/** Missing Claude evidence, including old snapshots, is never an attestation. */
export function runtimeEffortLabel(
  pin: Pick<RuntimePin, "runtimeKind" | "effort">,
  info: Pick<RuntimeInfo, "effortAttested"> | null | undefined,
  requested: string,
): string | null {
  if (!pin.effort) return null;
  const unattested =
    info?.effortAttested === false ||
    (pin.runtimeKind === "claude-code" && info?.effortAttested !== true);
  return unattested ? `${pin.effort} · ${requested}` : pin.effort;
}

/** The header describes the current bot pin; evidence for another pin cannot attest it. */
export function botEffortLabel(
  bot: Pick<
    Bot,
    | "runtimeKind"
    | "modelProvider"
    | "modelId"
    | "thinkingLevel"
    | "modelCredentialId"
    | "modelPinRevision"
  >,
  run: { runtimePin?: RuntimePin | null; runtimeInfo?: RuntimeInfo | null } | null | undefined,
  requested: string,
): string | null {
  const pin = run?.runtimePin;
  const matches =
    pin &&
    pin.runtimeKind === bot.runtimeKind &&
    pin.provider === bot.modelProvider &&
    pin.modelId === bot.modelId &&
    pin.effort === bot.thinkingLevel &&
    pin.credentialId === bot.modelCredentialId &&
    pin.revision === bot.modelPinRevision;
  return runtimeEffortLabel(
    { runtimeKind: bot.runtimeKind, effort: bot.thinkingLevel },
    matches && run?.runtimeInfo?.runtimeKind === bot.runtimeKind ? run.runtimeInfo : undefined,
    requested,
  );
}
