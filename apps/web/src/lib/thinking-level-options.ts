import type { ThinkingLevel } from "@ardurbot/contracts";
import { t } from "@lingui/core/macro";

export function thinkingLevelDescription(level: ThinkingLevel): string {
  switch (level) {
    case "off":
      return t`off — no extra thinking`;
    case "minimal":
      return t`minimal — quickest, for simple tasks`;
    case "low":
      return t`low — quick, with a little checking`;
    case "medium":
      return t`medium — balances speed and care`;
    case "high":
      return t`high — slower, checks more carefully`;
    case "xhigh":
      return t`xhigh — very slow, very careful`;
    case "max":
      return t`max — slowest, most careful`;
  }
}

export function thinkingLevelOptions() {
  return (["minimal", "low", "medium", "high", "xhigh", "max"] as const).map((value) => ({
    value,
    label: thinkingLevelDescription(value),
  }));
}
