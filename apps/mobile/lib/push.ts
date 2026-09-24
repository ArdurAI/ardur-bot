import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { rpc } from "./api";

export function hasPushDelivery() {
  return Boolean(Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId);
}

export async function registerPushToken() {
  const existing = await Notifications.getPermissionsAsync();
  const granted = existing.granted || (await Notifications.requestPermissionsAsync()).granted;
  if (!granted) return false;
  try {
    const projectId = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId;
    if (!projectId) return false;
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    if (!token) return false;
    await rpc("notifications/registerPush", { token });
    return true;
  } catch {
    // Expo Go cannot mint an ExponentPushToken without an EAS project id.
    return false;
  }
}

export async function unregisterPushToken() {
  await rpc("notifications/unregisterPush").catch(() => undefined);
}
