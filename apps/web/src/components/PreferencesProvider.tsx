import type { PreferencesPatch, UserPreferences } from "@ardurbot/contracts";
import { DEFAULT_USER_PREFERENCES } from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useLayoutEffect, useState } from "react";
import {
  applyPreferences,
  cachedPreferences,
  loadPreferences,
  updatePreferences,
} from "../lib/preferences";
import { ShellSkeleton } from "./ShellSkeleton";

type PreferencesState = {
  preferences: UserPreferences;
  ready: boolean;
  reload: () => void;
  update: (patch: PreferencesPatch) => Promise<void>;
};
const Context = createContext<PreferencesState | null>(null);

export function PreferencesProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const [preferences, setPreferences] = useState(
    () => cachedPreferences(userId) ?? DEFAULT_USER_PREFERENCES,
  );
  const [ready, setReady] = useState(false);
  const [settled, setSettled] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useLayoutEffect(() => applyPreferences(preferences), [preferences]);
  useEffect(() => {
    let active = true;
    void loadPreferences(userId)
      .then((next) => {
        if (active) {
          setPreferences(next);
          setReady(true);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setSettled(true);
      });
    return () => {
      active = false;
    };
  }, [userId, attempt]);
  async function update(patch: PreferencesPatch) {
    const next = await updatePreferences(userId, patch);
    setPreferences(next);
    setReady(true);
  }
  return (
    <Context value={{ preferences, ready, update, reload: () => setAttempt((value) => value + 1) }}>
      {settled ? children : <ShellSkeleton />}
    </Context>
  );
}

export function usePreferences() {
  const value = useContext(Context);
  if (!value) throw new Error("Preferences require an authenticated shell.");
  return value;
}
