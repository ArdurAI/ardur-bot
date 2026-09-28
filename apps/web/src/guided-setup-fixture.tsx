import type { SetupSnapshot } from "@ardurbot/contracts/desktop-setup";
import { GuidedSetupView, guidedSetupText } from "@ardurbot/ui-web/components/guided-setup";
import "../../../packages/ui-tokens/src/tokens.css";
import "../../../packages/ui-web/src/components/guided-setup.css";
import { createRoot } from "react-dom/client";

const ids = [
  "prerequisites",
  "database",
  "migrations",
  "command",
  "services",
  "engines",
  "model",
  "first-bot",
  "finish",
] as const;
const snapshot: SetupSnapshot = {
  schemaVersion: 1,
  planVersion: 1,
  runId: "00000000-0000-4000-8000-000000000001",
  sequence: 4,
  mode: "local",
  currentStep: "command",
  machineReady: false,
  accountReady: false,
  complete: false,
  interrupted: false,
  blocked: false,
  steps: ids.map((id, index) => ({
    id,
    available: index < 4,
    revision: index < 4 ? 1 : 0,
    attempt: index < 4 ? 1 : 0,
    status: index < 3 ? "succeeded" : index === 3 ? "waiting-input" : "pending",
    activeElapsedMs: index === 0 ? 26 : index === 1 ? 19_800 : index === 2 ? 64_000 : 0,
    waitingElapsedMs: 0,
    verifiedAt: index < 3 ? 1 : null,
    reasonCode: index < 3 ? "already-ready" : index === 3 ? "command-absent" : null,
    details: [],
  })),
};

document.body.style.cssText =
  "margin:0;background:var(--background);color:var(--foreground);font:14px system-ui";
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <main style={{ maxWidth: 660, margin: "40px auto", padding: 24 }}>
      <h1>{guidedSetupText.title}</h1>
      <GuidedSetupView
        snapshot={snapshot}
        onStart={() => undefined}
        onRetry={() => undefined}
        onSkip={() => undefined}
        onCancel={() => undefined}
        onResume={() => undefined}
        onCopyDetails={async () => true}
      />
    </main>,
  );
