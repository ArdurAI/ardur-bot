import type { SealPhase } from "@ardurbot/core";
import { useSealScenePack } from "@ardurbot/ui-web";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";

/**
 * The web catalog message for a seal pack's label key. The context keeps phase
 * labels apart from the same English words elsewhere, such as the model's
 * "Thinking" level. A pack that adds a label key adds its message here.
 */
export function sealLabelMessage(labelKey: string): MessageDescriptor | undefined {
  switch (labelKey) {
    case "Idle":
      return msg({ message: "Idle", context: "Bot seal phase" });
    case "Starting":
      return msg({ message: "Starting", context: "Bot seal phase" });
    case "Thinking":
      return msg({ message: "Thinking", context: "Bot seal phase" });
    case "Searching":
      return msg({ message: "Searching", context: "Bot seal phase" });
    case "Working through steps":
      return msg({ message: "Working through steps", context: "Bot seal phase" });
    case "Waiting for you":
      return msg({ message: "Waiting for you", context: "Bot seal phase" });
    case "Paused":
      return msg({ message: "Paused", context: "Bot seal phase" });
    case "Done":
      return msg({ message: "Done", context: "Bot seal phase" });
    case "Something went wrong":
      return msg({ message: "Something went wrong", context: "Bot seal phase" });
    default:
      return undefined;
  }
}

/** The reader's language label for a phase in the chosen pack. */
export function useSealPhaseLabel(): (phase: SealPhase) => string {
  const { i18n } = useLingui();
  const pack = useSealScenePack();
  return (phase) => {
    const labelKey = pack.phases[phase].labelKey;
    const message = sealLabelMessage(labelKey);
    return message ? i18n._(message) : labelKey;
  };
}
