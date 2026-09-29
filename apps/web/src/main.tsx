import { StrictMode, useEffect, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { DesktopUpdatesProvider } from "./components/DesktopUpdates";
import { I18nBootstrap } from "./components/I18nBootstrap";
import { applyUiDirection } from "./lib/apply-ui-direction";
import { bootstrapI18n } from "./lib/i18n";
import { installNavigationGuard } from "./lib/navigation-guard";
import { markAfterPaint, markOnce } from "./lib/performance";
import { installPreloadRecovery } from "./lib/preload-recovery";
import { applyUiAppearance, watchSystemAppearance } from "./lib/ui-appearance";
import { resolveUiLocale } from "./lib/ui-locale";
import "./styles.css";

markOnce("rk:renderer:module-evaluated");
installNavigationGuard();
installPreloadRecovery();
const locale = resolveUiLocale();
applyUiDirection(locale);
applyUiAppearance();

function PerformanceProbe() {
  useLayoutEffect(() => {
    markOnce("rk:renderer:first-react-commit");
    markAfterPaint("rk:renderer:first-react-painted");
  }, []);
  return null;
}

function AppearanceSync() {
  useEffect(() => watchSystemAppearance(), []);
  return null;
}

function renderApp() {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <PerformanceProbe />
      <AppearanceSync />
      <I18nBootstrap>
        <BrowserRouter>
          <DesktopUpdatesProvider>
            <App />
          </DesktopUpdatesProvider>
        </BrowserRouter>
      </I18nBootstrap>
    </StrictMode>,
  );
}

// The first frame is already in the saved language: its catalog loads before React renders.
void bootstrapI18n(locale).then(renderApp, renderApp);
