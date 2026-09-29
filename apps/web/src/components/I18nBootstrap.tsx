import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { bootstrapI18n, isUiLocaleSettled } from "../lib/i18n";
import { resolveUiLocale } from "../lib/ui-locale";

export function I18nBootstrap({ children }: { children: ReactNode }) {
  // main.tsx loads the saved language before React renders, so the first frame is normally ready.
  // Any other active catalog may be an older language: show nothing until this one is on screen.
  const [ready, setReady] = useState(() => isUiLocaleSettled(resolveUiLocale()));

  useEffect(() => {
    if (ready) return;
    let cancelled = false;
    // activateUiLocale already falls back to English on catalog failure.
    void bootstrapI18n(resolveUiLocale()).finally(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [ready]);

  if (!ready) {
    return (
      <div
        className="grid h-full place-items-center text-muted-foreground/80"
        data-ardurbot-app-state="i18n-pending"
      />
    );
  }

  return <I18nProvider i18n={i18n}>{children}</I18nProvider>;
}
