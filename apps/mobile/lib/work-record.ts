import { AccessibilityInfo } from "react-native";
import { t } from "./i18n";

export type WorkRecordStatus = "working" | "done" | "failed";

/**
 * Spoken name for the record's disclosure. Its status symbols are visual only,
 * so the name carries the outcome as well as the current title.
 */
export function workRecordLabel(status: WorkRecordStatus, title: string): string {
  const shown = title.trim();
  if (status === "working") return shown ? t("Working: {title}", { title: shown }) : t("Working");
  if (status === "failed") return shown ? t("Failed: {title}", { title: shown }) : t("Failed");
  return shown ? t("Done: {title}", { title: shown }) : t("Done");
}

/**
 * Reports whether an active record may pulse, now and whenever Reduce Motion
 * changes. Until the setting is known, or when it cannot be read, nothing is
 * reported and the record stays still. Returns the unsubscribe.
 */
export function watchMotionAllowed(onChange: (allowed: boolean) => void): () => void {
  let subscribed = true;
  let changed = false;
  const subscription = AccessibilityInfo.addEventListener(
    "reduceMotionChanged",
    (reduceMotion: boolean) => {
      changed = true;
      if (subscribed) onChange(!reduceMotion);
    },
  );
  AccessibilityInfo.isReduceMotionEnabled().then(
    (reduceMotion) => {
      // A change event is newer than the first answer.
      if (subscribed && !changed) onChange(!reduceMotion);
    },
    () => {},
  );
  return () => {
    subscribed = false;
    subscription.remove();
  };
}
