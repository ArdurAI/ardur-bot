import type { PreferencesPatch, UserPreferences } from "@ardurbot/contracts";
import { DEFAULT_USER_PREFERENCES, UserPreferencesSchema } from "@ardurbot/contracts";
import { rpc } from "./rpc";
import { setUiAppearance } from "./ui-appearance";

export const PREFERENCES_CACHE_KEY = "ardurbot.preferences";
const requests = new Map<string, Promise<UserPreferences>>();

export function applyPreferences(preferences: UserPreferences) {
  setUiAppearance(preferences.theme);
  document.documentElement.dataset.chatFont = preferences.chatFont;
  document.documentElement.dataset.motion = preferences.motion;
}

export function cachedPreferences(userId: string): UserPreferences | null {
  try {
    const cached = JSON.parse(localStorage.getItem(PREFERENCES_CACHE_KEY) ?? "null");
    if (cached?.userId !== userId) return null;
    const parsed = UserPreferencesSchema.safeParse(cached.preferences);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function savePreferencesCache(userId: string, preferences: UserPreferences) {
  try {
    localStorage.setItem(PREFERENCES_CACHE_KEY, JSON.stringify({ userId, preferences }));
  } catch {
    /* Appearance still works when storage is unavailable. */
  }
}

/** StrictMode and concurrent shell consumers share one account-scoped read. */
export function loadPreferences(userId: string): Promise<UserPreferences> {
  let request = requests.get(userId);
  if (!request) {
    request = rpc.preferences
      .get()
      .then((preferences) => {
        savePreferencesCache(userId, preferences);
        return preferences;
      })
      .catch((error: unknown) => {
        requests.delete(userId);
        throw error;
      });
    requests.set(userId, request);
  }
  return request;
}

export async function updatePreferences(userId: string, patch: PreferencesPatch) {
  const { preferences } = await rpc.preferences.update(patch);
  requests.set(userId, Promise.resolve(preferences));
  savePreferencesCache(userId, preferences);
  return preferences;
}

export function resetPreferences() {
  requests.clear();
  try {
    localStorage.removeItem(PREFERENCES_CACHE_KEY);
  } catch {
    /* Storage is optional. */
  }
  applyPreferences(DEFAULT_USER_PREFERENCES);
}
