import { NotificationActivityTracker, notify } from "@ardurbot/core";
import { useEffect } from "react";
import { usePreferences } from "../components/PreferencesProvider";
import { desktopBridge } from "./desktop";
import { i18n } from "./i18n";
import { rpc } from "./rpc";

/** Covers all account threads, even when another bot or space is open. */
export function useNotifications() {
  const { ready } = usePreferences();
  useEffect(() => {
    const desktop = desktopBridge()?.notifications;
    if (!ready || (!desktop && typeof Notification === "undefined")) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let tracker = new NotificationActivityTracker();
    let userId: string | null = null;
    async function poll() {
      try {
        const snapshot = await rpc.notifications.activity();
        if (!active) return;
        if (userId !== snapshot.userId) {
          tracker = new NotificationActivityTracker();
          userId = snapshot.userId;
        }
        for (const row of tracker.accept(snapshot.activities)) {
          if (
            row.category === "dispatchMessages" ||
            (!desktop && Notification.permission !== "granted") ||
            (document.visibilityState === "visible" && document.hasFocus())
          )
            continue;
          const title =
            row.status === "completed"
              ? i18n._({
                  id: "{name} finished",
                  message: "{name} finished",
                  values: { name: row.name },
                })
              : row.status === "failed"
                ? i18n._({
                    id: "{name} failed",
                    message: "{name} failed",
                    values: { name: row.name },
                  })
                : i18n._({
                    id: "{name} needs your input",
                    message: "{name} needs your input",
                    values: { name: row.name },
                  });
          await notify(
            { id: row.id, category: row.category, title, body: "", threadId: row.threadId },
            snapshot.preferences.notifications,
            async (event) => {
              if (desktop) await desktop.show(event);
              else new Notification(event.title, { tag: event.threadId });
            },
          );
        }
      } catch {
        /* A later poll retries transport failures without replaying history. */
      } finally {
        if (active) timer = setTimeout(() => void poll(), 5000);
      }
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [ready]);
}
