import type { RuntimePin } from "@ardurbot/contracts";
import { failureCategoryFromText } from "@ardurbot/contracts";
import { rpcErrorMessage } from "@ardurbot/core";
import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { rpc } from "./api";
import { failureCategoryText } from "./failure-categories";
import { useI18n } from "./i18n";

export type CanRunChoice = Omit<RuntimePin, "revision"> & {
  botId?: string;
  computerMode?: "team" | "dedicated";
  runtimeExperimental?: boolean;
  computerLocation?: "host" | "sandbox";
};

/** Native transport and focus boundary; eligibility is decided only by the server. */
export function useCanRun(choice: CanRunChoice | null) {
  const { t } = useI18n();
  const fallbackRef = useRef(t("Could not check the model. Try again."));
  fallbackRef.current = t("Could not check the model. Try again.");
  const key = JSON.stringify(choice);
  const [revision, setRevision] = useState(0);
  const requestKey = `${key}:${revision}`;
  const [checked, setChecked] = useState<{ key: string; error: string | null } | null>(null);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setRevision((value) => value + 1);
    });
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (key === "null") return;
    let active = true;
    void rpc("models/validatePin", JSON.parse(key)).then(
      () => {
        if (active) setChecked({ key: requestKey, error: null });
      },
      (error: unknown) => {
        if (!active) return;
        const safe =
          error &&
          typeof error === "object" &&
          "message" in error &&
          typeof error.message === "string"
            ? {
                message: error.message,
                code: "code" in error && typeof error.code === "string" ? error.code : undefined,
              }
            : { message: fallbackRef.current };
        setChecked({ key: requestKey, error: rpcErrorMessage(safe, fallbackRef.current) });
      },
    );
    return () => {
      active = false;
    };
  }, [key, requestKey]);
  const pending = key !== "null" && checked?.key !== requestKey;
  const raw = !pending && key !== "null" ? checked?.error : null;
  const category = raw ? failureCategoryFromText(raw) : null;
  const error = raw
    ? category
      ? failureCategoryText(category.id, category.params)
      : t(raw)
    : null;
  return {
    pending,
    error,
    blocked: pending || Boolean(error),
    recheck: () => setRevision((value) => value + 1),
  };
}
