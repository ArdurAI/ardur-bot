import type { SetupSnapshot } from "@ardurbot/contracts/desktop-setup";
import { GuidedSetupView, guidedSetupText } from "@ardurbot/ui-web/components/guided-setup";
import "../../../packages/ui-tokens/src/tokens.css";
import "../../../packages/ui-web/src/components/guided-setup.css";
import { useState } from "react";
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
const fixtureCase = new URLSearchParams(window.location.search).get("case") ?? "services";
const currentStep =
  fixtureCase === "engines" || fixtureCase === "engines-failed"
    ? "engines"
    : fixtureCase === "recheck"
      ? "prerequisites"
      : "services";
const snapshot: SetupSnapshot = {
  schemaVersion: 1,
  planVersion: 1,
  runId: "00000000-0000-4000-8000-000000000001",
  sequence: 4,
  mode: "local",
  currentStep,
  machineReady: false,
  accountReady: false,
  complete: false,
  interrupted: false,
  blocked: false,
  steps: ids.map((id, index) => ({
    id,
    available: index < 6,
    revision: index < 6 ? 1 : 0,
    attempt: index < 6 ? 1 : 0,
    status:
      fixtureCase === "recheck"
        ? index === 0
          ? "checking"
          : index < 6
            ? "succeeded"
            : "pending"
        : index < 4
          ? "succeeded"
          : index === 4
            ? fixtureCase === "services"
              ? "waiting-input"
              : "succeeded"
            : index === 5 && fixtureCase === "engines"
              ? "succeeded"
              : index === 5 && fixtureCase === "engines-failed"
                ? "failed"
                : "pending",
    activeElapsedMs: index === 0 ? 26 : index === 1 ? 19_800 : index === 2 ? 64_000 : 0,
    waitingElapsedMs: 0,
    verifiedAt: index < 4 ? 1 : null,
    reasonCode:
      fixtureCase === "services" && index === 4
        ? "services-not-ready"
        : fixtureCase === "engines-failed" && index === 5
          ? "discovery-timeout"
          : null,
    details:
      fixtureCase === "engines" && index === 5
        ? [
            { code: "target-discovered", text: "Docker 1" },
            { code: "target-connected", text: "Podman 1" },
            { code: "target-unavailable", text: "Kubernetes 1" },
          ]
        : [],
  })),
};

document.body.style.cssText =
  "margin:0;background:var(--background);color:var(--foreground);font:14px system-ui";
const root = document.getElementById("root");
function Fixture() {
  const [startupChoice, setStartupChoice] = useState(false);
  return (
    <main style={{ maxWidth: 660, margin: "40px auto", padding: 24 }}>
      <h1>{guidedSetupText.title}</h1>
      <GuidedSetupView
        snapshot={snapshot}
        startupSupported
        startupChoice={startupChoice}
        onStartupChoice={setStartupChoice}
        onStart={() => undefined}
        onRetry={() => undefined}
        onSkip={() => undefined}
        onCancel={() => undefined}
        onResume={() => undefined}
        onCopyDetails={async () => true}
      />
    </main>
  );
}
if (root) createRoot(root).render(<Fixture />);
