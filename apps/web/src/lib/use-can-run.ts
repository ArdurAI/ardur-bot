import type { RuntimePin } from "@ardurbot/contracts";
import { failureCategoryFromText } from "@ardurbot/contracts";
import { rpcErrorMessage } from "@ardurbot/core";
import { i18n } from "@lingui/core";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import { failureCategoryMessages } from "./failure-category-copy";
import { hermesContextMessage } from "./hermes-refusal";
import { rpc } from "./rpc";

export type CanRunChoice = Omit<RuntimePin, "revision"> & {
  botId?: string;
  inheritBotPin?: boolean;
  computerMode?: "team" | "dedicated";
  runtimeExperimental?: boolean;
  computerLocation?: "host" | "sandbox";
};

export function runSettingsMessage(message: string): string {
  const category = failureCategoryFromText(message);
  return category
    ? i18n._({ ...failureCategoryMessages[category.id], values: category.params })
    : hermesContextMessage(message);
}

/** No eligibility rules live in the form. An older response never unlocks a newer choice. */
export function useCanRun(choice: CanRunChoice | null) {
  const { t } = useLingui();
  const fallback = t`Could not check the model. Try again.`;
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  const key = JSON.stringify(choice);
  const [revision, setRevision] = useState(0);
  const requestKey = `${key}:${revision}`;
  const [checked, setChecked] = useState<{ key: string; error: string | null } | null>(null);
  useEffect(() => {
    const reload = () => setRevision((value) => value + 1);
    window.addEventListener("fleet:changed", reload);
    window.addEventListener("models:changed", reload);
    return () => {
      window.removeEventListener("fleet:changed", reload);
      window.removeEventListener("models:changed", reload);
    };
  }, []);
  useEffect(() => {
    if (key === "null") return;
    let active = true;
    void rpc.models.validatePin(JSON.parse(key) as CanRunChoice).then(
      () => {
        if (active) setChecked({ key: requestKey, error: null });
      },
      (error: unknown) => {
        if (active)
          setChecked({
            key: requestKey,
            error: rpcErrorMessage(
              error &&
                typeof error === "object" &&
                "message" in error &&
                typeof error.message === "string"
                ? {
                    message: error.message,
                    code:
                      "code" in error && typeof error.code === "string" ? error.code : undefined,
                  }
                : { message: fallbackRef.current },
              fallbackRef.current,
            ),
          });
      },
    );
    return () => {
      active = false;
    };
  }, [key, requestKey]);
  const pending = key !== "null" && checked?.key !== requestKey;
  const error =
    !pending && key !== "null" && checked?.error ? runSettingsMessage(checked.error) : null;
  return {
    pending,
    error,
    blocked: pending || Boolean(error),
    recheck: () => setRevision((value) => value + 1),
  };
}
