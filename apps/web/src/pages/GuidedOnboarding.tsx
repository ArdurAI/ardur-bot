import { Button } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { desktopBridge } from "../lib/desktop";
import { rpc } from "../lib/rpc";
import { useFirstBotSetup } from "../lib/use-first-bot-setup";
import { ModelSettingsOverlay } from "./ModelSettingsOverlay";

/** The desktop checklist owns progress; this page keeps account actions authenticated. */
export function GuidedOnboardingPage() {
  const { t } = useLingui();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const ensureFirstBot = useFirstBotSetup();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"model-incomplete" | "create-failed" | null>(null);
  const [account, setAccount] = useState<{
    model: "missing" | "saved" | "checked";
    firstBot: boolean;
  } | null>(null);
  const stopped = useRef(false);
  const createStatus = useRef<AbortController | null>(null);
  const saveWait = useRef<Promise<void> | null>(null);
  const settleSave = useRef<(() => void) | null>(null);
  const bridge = desktopBridge()?.guidedSetup;
  const step = params.get("step");

  const onSavePendingChange = useCallback((pending: boolean) => {
    if (pending && saveWait.current === null) {
      saveWait.current = new Promise<void>((resolve) => {
        settleSave.current = resolve;
      });
    } else if (!pending) {
      settleSave.current?.();
      settleSave.current = null;
      saveWait.current = null;
    }
  }, []);

  useEffect(() => {
    const unsubscribe = bridge?.onChange((snapshot) => {
      stopped.current = snapshot.steps.some(
        (row) => row.status === "cancelling" || row.status === "cancelled",
      );
      if (stopped.current) {
        createStatus.current?.abort();
        void (async () => {
          await saveWait.current;
          navigate("/guided-onboarding?step=finish", { replace: true });
        })();
      }
    });
    return unsubscribe;
  }, [bridge, navigate]);

  useEffect(() => {
    stopped.current = false;
    return () => {
      stopped.current = true;
      createStatus.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (step !== "finish") return;
    let active = true;
    void rpc.guidedSetup.status().then(
      (status) => {
        if (active) setAccount(status);
      },
      () => {
        if (active) setAccount(null);
      },
    );
    return () => {
      active = false;
    };
  }, [step]);

  async function returnToSetup() {
    await saveWait.current;
    if (!stopped.current) await bridge?.refreshAccount();
    await bridge?.returnToSetup();
  }

  async function createBot() {
    if (busy || stopped.current) return;
    const controller = new AbortController();
    createStatus.current = controller;
    setBusy(true);
    setError(null);
    try {
      const status = await rpc.guidedSetup.status(undefined, { signal: controller.signal });
      if (stopped.current || controller.signal.aborted) return;
      if (status.model === "missing") {
        setError("model-incomplete");
        return;
      }
      const bot = await ensureFirstBot();
      if (stopped.current) return;
      // The API makes this card idempotent, even when a create committed before a crash.
      await rpc.onboarding.start({ botId: bot.id });
      if (stopped.current) return;
      await rpc.onboarding.promptFocus({ botId: bot.id });
      if (stopped.current) return;
      navigate(`/app/${bot.id}`);
      await returnToSetup();
    } catch {
      if (!stopped.current) setError("create-failed");
    } finally {
      if (createStatus.current === controller) createStatus.current = null;
      setBusy(false);
    }
  }

  return (
    <main
      data-ardurbot-surface="guided-onboarding"
      className="h-full overflow-y-auto bg-background px-6 py-8"
    >
      <div className="mx-auto max-w-3xl space-y-6">
        <Button variant="secondary" onClick={() => void returnToSetup()}>
          <Trans>Return to setup</Trans>
        </Button>
        {step === "model" ? (
          <>
            <h1 className="text-2xl font-medium">
              <Trans>Connect a model</Trans>
            </h1>
            <ModelSettingsOverlay
              embedded
              onClose={() => void returnToSetup()}
              onSavePendingChange={onSavePendingChange}
            />
          </>
        ) : step === "bot" ? (
          <>
            <h1 className="text-2xl font-medium">
              <Trans>Create your first bot</Trans>
            </h1>
            <Button disabled={busy} onClick={() => void createBot()}>
              <Trans>Create bot</Trans>
            </Button>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-medium">
              <Trans>Finish setup</Trans>
            </h1>
            {account?.model === "missing" && (
              <p>
                <Trans>Model setup is incomplete</Trans>
              </p>
            )}
            {account && !account.firstBot && (
              <p>
                <Trans>First bot not created</Trans>
              </p>
            )}
            {account?.model === "missing" ? (
              <Button onClick={() => navigate("/guided-onboarding?step=model")}>
                <Trans>Open Models</Trans>
              </Button>
            ) : account && !account.firstBot ? (
              <Button disabled={busy} onClick={() => void createBot()}>
                <Trans>Create bot</Trans>
              </Button>
            ) : null}
          </>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error === "model-incomplete"
              ? t`Model setup is incomplete`
              : t`The first bot could not be created. Try again.`}
          </p>
        )}
        {error === "model-incomplete" && (
          <Button onClick={() => navigate("/guided-onboarding?step=model")}>
            <Trans>Open Models</Trans>
          </Button>
        )}
      </div>
    </main>
  );
}
