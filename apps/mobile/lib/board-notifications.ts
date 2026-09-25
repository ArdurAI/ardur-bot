import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import { useEffect } from "react";
import { selectSpace } from "./api";

export function boardNotificationTarget(data: Record<string, unknown>) {
  const target = data.board;
  if (
    !target ||
    typeof target !== "object" ||
    !("spaceId" in target) ||
    !("workspaceId" in target) ||
    !("itemId" in target)
  )
    return null;
  if (
    typeof target.spaceId !== "string" ||
    typeof target.workspaceId !== "string" ||
    typeof target.itemId !== "string"
  )
    return null;
  return { spaceId: target.spaceId, workspace: target.workspaceId, item: target.itemId };
}
export function useBoardNotifications(ready: boolean) {
  const router = useRouter();
  useEffect(() => {
    if (!ready) return;
    let active = true;
    let lastId = "";
    const open = async (response: Notifications.NotificationResponse | null) => {
      if (!response || !active || lastId === response.notification.request.identifier) return;
      lastId = response.notification.request.identifier;
      const target = boardNotificationTarget(response.notification.request.content.data ?? {});
      if (target && (await selectSpace(target.spaceId)) && active)
        router.push({
          pathname: "/overview",
          params: { view: "board", workspace: target.workspace, item: target.item },
        });
    };
    void Notifications.getLastNotificationResponseAsync()
      .then(open)
      .catch(() => undefined);
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      void open(response).catch(() => undefined);
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, [ready, router]);
}
