import { LOCAL_SETTINGS_PAGE } from "@ardurbot/contracts";
import { Button } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Navigate, Route, Routes, useSearchParams } from "react-router-dom";
import { LoadingState } from "./components/ai/primitives";
import { PreferencesProvider } from "./components/PreferencesProvider";
import { ShellSkeleton } from "./components/ShellSkeleton";
import { authClient } from "./lib/auth";
import { authReturnPath } from "./lib/auth-return-path";
import { markAfterPaint, markOnce } from "./lib/performance";
import { resetPreferences } from "./lib/preferences";
import {
  holdUnreachableGate,
  sessionGate,
  sessionRetryDelayMs,
  showSessionUnavailable,
} from "./lib/session-gate";
import { IntegrationSetupPage } from "./pages/IntegrationSetup";
import { LocalSettingsPage } from "./pages/LocalSettings";
import { McpOAuthCallbackPage } from "./pages/McpOAuthCallback";
import { SharedCommandPage, SharedCommandSignIn } from "./pages/SharedCommand";
import { ShellPage } from "./pages/Shell";
import { QuickComposer } from "./pages/system/QuickComposer";

const IdePage = lazy(() => import("./pages/ide/IdePage"));

const AuthPage = lazy(() =>
  import("./pages/Auth").then((module) => ({ default: module.AuthPage })),
);
const PasswordResetPage = lazy(() =>
  import("./pages/Auth").then((module) => ({ default: module.PasswordResetPage })),
);
const OnboardingPage = lazy(() =>
  import("./pages/Onboarding").then((module) => ({ default: module.OnboardingPage })),
);
const WelcomePage = lazy(() =>
  import("./pages/Welcome").then((module) => ({ default: module.WelcomePage })),
);
const NotFoundPage = lazy(() => import("./pages/NotFound"));

export function App() {
  if (window.location.pathname === LOCAL_SETTINGS_PAGE) return <LocalSettingsPage />;
  return <SessionApp />;
}

function SessionApp() {
  const [searchParams] = useSearchParams();
  const signInDestination = authReturnPath(searchParams.get("next"));
  const session = authClient.useSession();
  const gate = sessionGate(session);
  useEffect(() => {
    if (gate === "anonymous") resetPreferences();
  }, [gate]);
  const [holdingUnreachable, setHoldingUnreachable] = useState(false);
  const nextHolding = holdUnreachableGate(gate, holdingUnreachable);
  if (nextHolding !== holdingUnreachable) setHoldingUnreachable(nextHolding);

  useLayoutEffect(() => {
    if (session.isPending) return;
    markOnce("rk:renderer:session-committed");
    markAfterPaint("rk:renderer:session-painted");
  }, [session.isPending]);

  if (showSessionUnavailable(gate, nextHolding)) {
    return <SessionUnavailable refetch={session.refetch} />;
  }
  if (gate === "loading") {
    return window.location.pathname.startsWith("/app") ? (
      <ShellSkeleton />
    ) : (
      <div
        className="grid h-full place-items-center text-muted-foreground/80"
        data-ardurbot-app-state="session-pending"
      >
        <Trans>Loading…</Trans>
      </div>
    );
  }

  const user = session.data?.user;
  const content = (
    <div className="h-full" data-ardurbot-app-state="ready">
      <Suspense fallback={<div className="h-full bg-background" />}>
        <Routes>
          <Route
            path="/desktop/quick-access"
            element={<QuickComposer signedIn={Boolean(user)} />}
          />
          <Route
            path="/commands/:runId/:commandId"
            element={user ? <SharedCommandPage /> : <SharedCommandSignIn />}
          />
          <Route path="/" element={user ? <Navigate to="/app" replace /> : <WelcomePage />} />
          <Route
            path="/sign-in"
            element={
              user ? <Navigate to={signInDestination} replace /> : <AuthPage key="in" mode="in" />
            }
          />
          <Route
            path="/sign-up"
            element={user ? <Navigate to="/onboarding" replace /> : <AuthPage key="up" mode="up" />}
          />
          <Route
            path="/forgot-password"
            element={
              user ? <Navigate to="/app" replace /> : <AuthPage key="forgot" mode="forgot" />
            }
          />
          <Route path="/reset-password" element={<PasswordResetPage />} />
          <Route
            path="/onboarding"
            element={user ? <OnboardingPage /> : <Navigate to="/sign-in" replace />}
          />
          <Route
            path="/mcp/oauth/callback"
            element={user ? <McpOAuthCallbackPage /> : <Navigate to="/sign-in" replace />}
          />
          <Route
            path="/integrations/setup"
            element={
              user ? (
                <IntegrationSetupPage />
              ) : (
                <Navigate to="/sign-in?next=/integrations/setup" replace />
              )
            }
          />
          <Route
            path="/app/ide"
            element={user ? <IdePage /> : <Navigate to="/sign-in" replace />}
          />
          <Route
            path="/app/team"
            element={user ? <ShellPage team /> : <Navigate to="/sign-in" replace />}
          />
          <Route path="/app" element={user ? <ShellPage /> : <Navigate to="/sign-in" replace />} />
          <Route
            path="/app/g/:groupId"
            element={user ? <ShellPage /> : <Navigate to="/sign-in" replace />}
          />
          <Route
            path="/app/:botId"
            element={user ? <ShellPage /> : <Navigate to="/sign-in" replace />}
          />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    </div>
  );
  return user ? (
    <PreferencesProvider key={user.id} userId={user.id}>
      {content}
    </PreferencesProvider>
  ) : (
    content
  );
}

/**
 * A session lookup that never reached the server is not a sign-out, so the app
 * waits and retries here instead of routing to sign-in and stranding a signed-in
 * user. Better Auth only polls once a session exists, so the retry lives here.
 */
function SessionUnavailable({ refetch }: { refetch: () => Promise<void> }) {
  const { t } = useLingui();
  const [attempt, setAttempt] = useState(0);
  const [retryKey, setRetryKey] = useState(0);
  const retryImmediately = useRef(false);
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  useEffect(() => {
    let cancelled = false;
    const delay = retryImmediately.current ? 0 : sessionRetryDelayMs(attempt);
    retryImmediately.current = false;
    const timer = setTimeout(() => {
      void refetchRef.current().finally(() => {
        if (!cancelled) setAttempt((value) => value + 1);
      });
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [attempt, retryKey]);

  return (
    <div className="grid h-full place-items-center bg-background px-6 text-center">
      <div className="flex flex-col items-center">
        <LoadingState label={t`Reconnecting`} />
        <p className="mt-3 text-[13.5px] text-muted-foreground/80">
          <Trans>Can&apos;t reach the server.</Trans>
        </p>
        <div className="mt-4">
          <Button
            variant="secondary"
            className="rounded-full"
            onClick={() => {
              retryImmediately.current = true;
              setAttempt(0);
              setRetryKey((key) => key + 1);
            }}
          >
            <Trans>Retry now</Trans>
          </Button>
        </div>
      </div>
    </div>
  );
}
