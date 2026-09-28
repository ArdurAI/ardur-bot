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
const accountCase = ["model-deferred", "bot-created", "incomplete", "complete"].includes(
  fixtureCase,
);
const currentStep =
  fixtureCase === "model-deferred"
    ? "first-bot"
    : fixtureCase === "bot-created"
      ? "first-bot"
      : fixtureCase === "incomplete" || fixtureCase === "complete"
        ? "finish"
        : fixtureCase === "engines" || fixtureCase === "engines-failed"
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
  machineReady: accountCase,
  accountReady: fixtureCase === "complete",
  complete: fixtureCase === "complete",
  interrupted: false,
  blocked: false,
  steps: ids.map((id, index) => ({
    id,
    available: accountCase || index < 6,
    revision: accountCase || index < 6 ? 1 : 0,
    attempt: accountCase || index < 6 ? 1 : 0,
    status: accountCase
      ? index < 6 ||
        fixtureCase === "complete" ||
        (fixtureCase === "bot-created" && index <= 7) ||
        (fixtureCase === "incomplete" && index === 8)
        ? "succeeded"
        : fixtureCase === "incomplete" && (index === 6 || index === 7)
          ? "skipped"
          : fixtureCase === "model-deferred" && index === 6
            ? "skipped"
            : fixtureCase === "model-deferred" && index === 7
              ? "waiting-input"
              : "pending"
      : fixtureCase === "recheck"
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
      accountCase && index === 6 && fixtureCase !== "incomplete" && fixtureCase !== "model-deferred"
        ? [{ code: "connection-saved", text: "Connection saved" }]
        : fixtureCase === "engines" && index === 5
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
        onOpenModels={() => undefined}
        onCreateBot={() => undefined}
        onContinue={() => undefined}
      />
    </main>
  );
}
if (root) createRoot(root).render(<Fixture />);
