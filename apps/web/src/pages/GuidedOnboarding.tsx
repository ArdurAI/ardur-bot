import { Button } from "@ardurbot/ui-web";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { desktopBridge } from "../lib/desktop";
import { rpc } from "../lib/rpc";
import { useFirstBotSetup } from "../lib/use-first-bot-setup";
import { ModelSettingsOverlay } from "./ModelSettingsOverlay";

/** The desktop checklist owns progress; this page keeps account actions authenticated. */
export function GuidedOnboardingPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const ensureFirstBot = useFirstBotSetup();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const stopped = useRef(false);
  const bridge = desktopBridge()?.guidedSetup;
  const step = params.get("step");

  useEffect(() => {
    return bridge?.onChange((snapshot) => {
      stopped.current = snapshot.steps.some(
        (row) => row.status === "cancelling" || row.status === "cancelled",
      );
      if (stopped.current) {
        navigate("/guided-onboarding?step=finish", { replace: true });
      }
    });
  }, [bridge, navigate]);

  async function returnToSetup() {
    if (!stopped.current) await bridge?.refreshAccount();
    await bridge?.returnToSetup();
  }

  async function createBot() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const status = await rpc.guidedSetup.status();
      if (status.model === "missing") {
        setError("Model setup is incomplete");
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
      if (!stopped.current) setError("The first bot could not be created. Try again.");
    } finally {
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
          Return to setup
        </Button>
        {step === "model" ? (
          <>
            <h1 className="text-2xl font-medium">Connect a model</h1>
            <ModelSettingsOverlay embedded onClose={() => void returnToSetup()} />
          </>
        ) : step === "bot" ? (
          <>
            <h1 className="text-2xl font-medium">Create your first bot</h1>
            <Button disabled={busy} onClick={() => void createBot()}>
              Create bot
            </Button>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-medium">Finish setup</h1>
            <Button onClick={() => navigate("/guided-onboarding?step=model")}>Open Models</Button>
          </>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        {error === "Model setup is incomplete" && (
          <Button onClick={() => navigate("/guided-onboarding?step=model")}>Open Models</Button>
        )}
      </div>
    </main>
  );
}
