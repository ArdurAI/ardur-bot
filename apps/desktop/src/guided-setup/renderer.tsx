import type { ArdurBotSetup } from "@ardurbot/contracts";
import type { SetupSnapshot, SetupStepId } from "@ardurbot/contracts/desktop-setup";
import { GuidedSetupView, guidedSetupText } from "@ardurbot/ui-web/components/guided-setup";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

const bridge = (window as Window & { ardurbotSetup?: ArdurBotSetup }).ardurbotSetup;
document.documentElement.dataset.platform = bridge?.platform ?? "browser";

export function SetupDocument({ setupBridge = bridge }: { setupBridge?: ArdurBotSetup }) {
  const bridge = setupBridge;
  const [snapshot, setSnapshot] = useState<SetupSnapshot | null>(null);
  const [mode, setMode] = useState<"local" | "server">("local");
  const [server, setServer] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [startupChoice, setStartupChoice] = useState(false);
  const [startupError, setStartupError] = useState("");

  useEffect(() => {
    const guided = bridge?.guidedSetup;
    if (!guided) return;
    let mounted = true;
    const unsubscribe = guided.onChange((next) => {
      if (mounted) setSnapshot((old) => (old && old.sequence > next.sequence ? old : next));
    });
    void guided
      .snapshot()
      .then((next) => {
        if (mounted) setSnapshot((old) => (old && old.sequence > next.sequence ? old : next));
      })
      .catch(() => {
        if (mounted) setStatus(guidedSetupText.loadFailed);
      });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  async function run(action: () => Promise<SetupSnapshot>) {
    if (busy || cancelBusy) return;
    setBusy(true);
    setStatus("");
    try {
      const next = await action();
      setSnapshot((old) => (old && old.sequence > next.sequence ? old : next));
    } catch {
      setStatus(guidedSetupText.updateFailed);
    } finally {
      setBusy(false);
    }
  }

  async function cancelSetup() {
    const guided = bridge?.guidedSetup;
    if (!guided || cancelBusy) return;
    setCancelBusy(true);
    setStatus("");
    try {
      const next = await guided.cancel();
      setSnapshot((old) => (old && old.sequence > next.sequence ? old : next));
    } catch {
      setStatus(guidedSetupText.updateFailed);
    } finally {
      setCancelBusy(false);
    }
  }

  async function connect() {
    if (!bridge || busy || cancelBusy) return;
    setBusy(true);
    setStatus(guidedSetupText.checking);
    try {
      const checked = await bridge.test(server);
      if (!checked.ok || !checked.url) {
        setStatus(checked.error ?? guidedSetupText.reachFailed);
        return;
      }
      const saved = await bridge.save({ mode: "existing", serverUrl: checked.url });
      if (!saved.ok) setStatus(saved.error ?? guidedSetupText.saveFailed);
    } catch {
      setStatus(guidedSetupText.connectFailed);
    } finally {
      setBusy(false);
    }
  }

  const guided = bridge?.guidedSetup;
  const modeLocked =
    busy ||
    cancelBusy ||
    !!snapshot?.steps.some((row) =>
      ["checking", "running", "verifying", "cancelling"].includes(row.status),
    );
  async function continueSetup() {
    if (!bridge || !guided || busy || cancelBusy) return;
    setBusy(true);
    setStatus("");
    try {
      const state = await bridge.stack.start();
      if (!state) throw new Error("Setup handoff is unavailable.");
      window.location.assign("setup.html");
    } catch {
      setStatus(guidedSetupText.updateFailed);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <header className="titlebar">
        <span className="titlebar-name">{guidedSetupText.brand}</span>
        <button className="titlebar-quit" type="button" onClick={() => void bridge?.quit()}>
          {guidedSetupText.quit}
        </button>
      </header>
      <main className="shell guided-shell">
        <h1 className="heading">{guidedSetupText.title}</h1>
        <fieldset className="choices" disabled={modeLocked}>
          <legend className="sr-only">{guidedSetupText.setupMode}</legend>
          <label className="choice">
            <input
              type="radio"
              name="mode"
              checked={mode === "local"}
              onChange={() => setMode("local")}
            />
            {guidedSetupText.thisComputer}
          </label>
          <label className="choice">
            <input
              type="radio"
              name="mode"
              checked={mode === "server"}
              onChange={() => setMode("server")}
            />
            {guidedSetupText.connectServer}
          </label>
        </fieldset>
        {mode === "server" ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void connect();
            }}
          >
            <label className="field-label" htmlFor="guided-server">
              {guidedSetupText.serverAddress}
            </label>
            <input
              className="field"
              id="guided-server"
              value={server}
              onChange={(event) => setServer(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder={guidedSetupText.serverPlaceholder}
            />
            <div className="actions">
              <button className="button button-primary" type="submit" disabled={busy}>
                {guidedSetupText.connectServer}
              </button>
            </div>
          </form>
        ) : snapshot && guided ? (
          <GuidedSetupView
            snapshot={snapshot}
            startupSupported={bridge.platform === "darwin" || bridge.platform === "win32"}
            startupChoice={startupChoice}
            startupError={startupError}
            onStartupChoice={(enabled) => {
              setStartupError("");
              void guided
                .setStartup(enabled)
                .then((result) => {
                  if (result.ok) setStartupChoice(result.enabled ?? false);
                  else setStartupError(result.error ?? "Could not change startup. Try again.");
                })
                .catch(() => setStartupError("Could not change startup. Try again."));
            }}
            onStart={() => void run(() => guided.start())}
            onRetry={(id: SetupStepId) => void run(() => guided.retry(id))}
            onSkip={(id: SetupStepId) => void run(() => guided.skip(id))}
            onCancel={() => void cancelSetup()}
            onResume={() => void run(() => guided.resume())}
            onClose={() => void bridge?.quit()}
            onContinue={() => void continueSetup()}
            onCopyDetails={async (text) => {
              try {
                await navigator.clipboard.writeText(text);
                return true;
              } catch {
                return false;
              }
            }}
          />
        ) : null}
        {status && (
          <p className="status" role="alert">
            {status}
          </p>
        )}
      </main>
    </>
  );
}

const root = document.getElementById("guided-root");
if (root) createRoot(root).render(<SetupDocument />);
