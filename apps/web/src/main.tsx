import { StrictMode, useEffect, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { App } from "./App";
import { DesktopUpdatesProvider } from "./components/DesktopUpdates";
import { I18nBootstrap } from "./components/I18nBootstrap";
import { applyUiDirection } from "./lib/apply-ui-direction";
import { markAfterPaint, markOnce } from "./lib/performance";
import { installPreloadRecovery } from "./lib/preload-recovery";
import { applyUiAppearance, watchSystemAppearance } from "./lib/ui-appearance";
import { resolveUiLocale } from "./lib/ui-locale";
import "./styles.css";

markOnce("rk:renderer:module-evaluated");
installPreloadRecovery();
applyUiDirection(resolveUiLocale());
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

const router = createBrowserRouter([
  {
    path: "*",
    element: (
      <DesktopUpdatesProvider>
        <App />
      </DesktopUpdatesProvider>
    ),
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PerformanceProbe />
    <AppearanceSync />
    <I18nBootstrap>
      <RouterProvider router={router} />
    </I18nBootstrap>
  </StrictMode>,
);
