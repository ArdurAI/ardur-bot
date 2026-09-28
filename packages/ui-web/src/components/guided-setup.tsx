import { useEffect, useRef, useState } from "react";
import type {
  SetupSnapshot,
  SetupStepId,
  SetupStepSnapshot,
} from "../../../contracts/src/desktop-setup.js";
import { Button } from "./ui/button.js";

/** English source strings for the local setup document; a later slice can supply a translated map. */
export const guidedSetupText = {
  title: "Set up Ardur",
  brand: "Ardur",
  thisComputer: "This computer",
  connectServer: "Connect to a server",
  setupMode: "Setup mode",
  serverAddress: "Server address",
  serverPlaceholder: "https://ardurbot.example.com",
  quit: "Quit",
  loadFailed: "Could not load setup. Try again.",
  updateFailed: "Could not update setup. Try again.",
  reachFailed: "Could not reach that address.",
  saveFailed: "Could not save that address.",
  connectFailed: "Could not connect to that server. Try again.",
  start: "Start setup",
  continue: "Continue setup",
  cancel: "Cancel",
  resume: "Resume",
  close: "Close",
  retry: "Retry",
  retryStop: "Retry stop",
  skip: "Skip",
  runOnStartup: "Run on startup",
  foundUnchecked: "Found; connection not checked",
  connected: "Connected",
  unknown: "Unknown",
  noComputers: "No optional computers found",
  showDetails: "Show details",
  hideDetails: "Hide details",
  copyDetails: "Copy details",
  detailsLabel: "Setup details",
  copied: "Details copied",
  copyFailed: "Could not copy. Select the text instead.",
  interrupted: "Setup was interrupted.",
  stopping: "Stopping safely…",
  stopFailed: "Ardur could not confirm that setup stopped.",
  path: "Installed; add its folder to PATH",
  waiting: "Waiting for you",
  pending: "Pending",
  unavailable: "Unavailable",
  ready: "Already ready",
  done: "Done",
  notNeeded: "Not needed",
  skipped: "Skipped",
  checking: "Checking…",
  stoppingRow: "Stopping…",
  stopped: "Stopped",
  running: "Running…",
  failed: "Failed",
  attempt: "Attempt",
  activeTime: "Active",
  waitingTime: "Waiting",
  steps: {
    prerequisites: "Check this computer",
    database: "Prepare local storage",
    migrations: "Update local storage",
    command: "Add the terminal command",
    services: "Start Ardur services",
    engines: "Check optional computers",
    model: "Connect a model",
    "first-bot": "Create your first bot",
    finish: "Finish setup",
  },
  errors: {
    prerequisites: "This computer could not be checked. Try again.",
    database: "Local storage could not start. Try again.",
    migrations: "Local storage could not be updated. Try again.",
    command: "The terminal command could not be added. Try again.",
    services: "Ardur services did not become ready. Try again.",
    engines: "Optional computers could not be checked. Try again.",
    model: "The connection could not be checked. Try again.",
    "first-bot": "The first bot could not be created. Try again.",
    finish: "Could not save setup. Try again.",
  },
  reasons: {
    "unsupported-computer": "This computer cannot run local setup. Connect to a server.",
    "embedded-binaries-missing": "This build is missing local storage files. Try another build.",
    "app-data-unwritable": "Ardur cannot write local storage. Check folder permissions and retry.",
    "space-check-unavailable": "Available storage could not be checked. Try again.",
    "insufficient-space": "This computer needs more free storage. Make space and retry.",
    "migration-history-unsafe":
      "Local storage could not be verified. Check the installed version and retry.",
    "database-ownership-unconfirmed": "Local storage ownership could not be confirmed. Try again.",
    "newer-journal": "Setup was saved by a newer version of Ardur. Update Ardur to continue.",
    "journal-write-failed": "Setup progress could not be saved. Check storage and retry.",
    "services-not-ready": "Ardur services did not become ready. Try again.",
    "discovery-timeout": "Optional computer discovery timed out. Retry.",
    "discovery-failed": "Optional computers could not be checked. Retry.",
  },
} as const;

export function formatSetupDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes} min ${Math.floor((ms % 60_000) / 1000)} s`;
}

function rowState(row: SetupStepSnapshot): string {
  if (!row.available) return guidedSetupText.unavailable;
  switch (row.status) {
    case "pending":
      return guidedSetupText.pending;
    case "checking":
    case "verifying":
      return guidedSetupText.checking;
    case "running":
      return guidedSetupText.running;
    case "waiting-input":
      return guidedSetupText.waiting;
    case "succeeded":
      return row.reasonCode === "already-ready" ? guidedSetupText.ready : guidedSetupText.done;
    case "not-applicable":
      return guidedSetupText.notNeeded;
    case "skipped":
      return guidedSetupText.skipped;
    case "cancelling":
      return guidedSetupText.stoppingRow;
    case "cancelled":
      return guidedSetupText.stopped;
    case "interrupted":
      return guidedSetupText.interrupted;
    case "failed":
      return guidedSetupText.failed;
  }
}

function failureSentence(row: SetupStepSnapshot): string {
  if (row.reasonCode && row.reasonCode in guidedSetupText.reasons)
    return guidedSetupText.reasons[row.reasonCode as keyof typeof guidedSetupText.reasons];
  return guidedSetupText.errors[row.id];
}

export interface GuidedSetupViewProps {
  snapshot: SetupSnapshot;
  labels?: Partial<Record<SetupStepId, string>>;
  onStart: () => void;
  onRetry: (id: SetupStepId) => void;
  onSkip: (id: SetupStepId) => void;
  onCancel: () => void;
  onResume: () => void;
  onCopyDetails: (text: string) => Promise<boolean>;
  onContinue?: () => void;
  onClose?: () => void;
  startupSupported?: boolean;
  startupChoice?: boolean;
  startupError?: string;
  onStartupChoice?: (enabled: boolean) => void;
}

export function GuidedSetupView(props: GuidedSetupViewProps) {
  const { snapshot } = props;
  const [expanded, setExpanded] = useState<SetupStepId | null>(null);
  const [copyMessage, setCopyMessage] = useState("");
  const [tick, setTick] = useState(0);
  const [visible, setVisible] = useState(!document.hidden);
  const [announcement, setAnnouncement] = useState("");
  const failureRef = useRef<HTMLButtonElement | null>(null);
  const focusedFailure = useRef("");
  const previousTransition = useRef("");
  const current =
    snapshot.steps.find((step) => step.id === snapshot.currentStep) ??
    snapshot.steps.find((step) => step.status === "failed");
  const active =
    current && ["checking", "running", "verifying", "cancelling"].includes(current.status);
  const stopFailed = snapshot.steps.some((row) => row.reasonCode === "cleanup-incomplete");
  const newerJournal = snapshot.steps.some((row) => row.reasonCode === "newer-journal");
  const stopping = snapshot.steps.some((row) => row.status === "cancelling");
  const pilotReady =
    snapshot.steps.slice(0, 3).every((row) => row.status === "succeeded") &&
    ["succeeded", "skipped", "not-applicable"].includes(snapshot.steps[3]?.status ?? "") &&
    snapshot.steps[4]?.status === "succeeded" &&
    ["succeeded", "skipped"].includes(snapshot.steps[5]?.status ?? "");
  const started = snapshot.steps.some((row) => row.attempt > 0 || row.status !== "pending");
  const cancelled = snapshot.steps.some((row) => row.status === "cancelled");

  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    setTick(0);
    if (!active || !visible) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [active, visible, snapshot.sequence]);

  useEffect(() => {
    const transition = `${snapshot.runId}:${current?.id}:${current?.status}`;
    if (transition === previousTransition.current) return;
    previousTransition.current = transition;
    if (current)
      setAnnouncement(
        `${props.labels?.[current.id] ?? guidedSetupText.steps[current.id]}, ${rowState(current)}`,
      );
  }, [snapshot.runId, current?.id, current?.status, props.labels]);

  useEffect(() => {
    if (current?.status !== "failed") return;
    const key = `${snapshot.runId}:${current.id}:${current.attempt}`;
    if (focusedFailure.current === key) return;
    focusedFailure.current = key;
    failureRef.current?.focus();
  }, [snapshot.runId, current?.id, current?.status, current?.attempt]);

  // Tick intentionally changes only elapsed text. The live region depends on state transitions.
  return (
    <section className="guided-setup" aria-label={guidedSetupText.title}>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      {snapshot.interrupted && <p className="guided-notice">{guidedSetupText.interrupted}</p>}
      {stopping && <p className="guided-notice">{guidedSetupText.stopping}</p>}
      {stopFailed && <p className="guided-error">{guidedSetupText.stopFailed}</p>}
      <ol className="guided-steps">
        {snapshot.steps.map((row) => {
          const isCurrent = row.id === current?.id;
          const open = expanded === row.id || (expanded === null && isCurrent);
          const details = [
            row.attempt > 1 ? `${guidedSetupText.attempt} ${row.attempt}` : "",
            ...row.details.map((detail) => detail.text),
          ]
            .filter(Boolean)
            .join("\n");
          const canDetails = row.details.length > 0 || row.attempt > 1;
          const elapsed = row.activeElapsedMs + (isCurrent && active ? tick * 1000 : 0);
          return (
            <li
              key={row.id}
              className="guided-step"
              data-status={row.status}
              aria-current={isCurrent ? "step" : undefined}
            >
              <div className="guided-row">
                <span className="guided-step-name">
                  {props.labels?.[row.id] ?? guidedSetupText.steps[row.id]}
                </span>
                <span className="guided-state">{rowState(row)}</span>
                {row.available && elapsed > 0 && (
                  <span className="guided-time" aria-hidden="true">
                    {formatSetupDuration(elapsed)}
                  </span>
                )}
                {row.available && canDetails && (
                  <Button
                    type="button"
                    variant="ghost"
                    className="guided-ghost"
                    aria-expanded={expanded === row.id}
                    aria-controls={`guided-details-${row.id}`}
                    onClick={() => {
                      setCopyMessage("");
                      setExpanded(expanded === row.id ? null : row.id);
                    }}
                  >
                    {expanded === row.id
                      ? guidedSetupText.hideDetails
                      : guidedSetupText.showDetails}
                  </Button>
                )}
              </div>
              {open && row.available && (
                <div className="guided-row-body">
                  {row.status === "failed" && (
                    <p className="guided-error">{failureSentence(row)}</p>
                  )}
                  {row.status === "waiting-input" && row.reasonCode === "add-folder-to-path" && (
                    <p>{guidedSetupText.path}</p>
                  )}
                  {row.id === "services" &&
                    row.status === "waiting-input" &&
                    props.startupSupported && (
                      <label className="guided-startup-choice">
                        <input
                          type="checkbox"
                          checked={props.startupChoice ?? false}
                          onChange={(event) => props.onStartupChoice?.(event.target.checked)}
                        />
                        {guidedSetupText.runOnStartup}
                      </label>
                    )}
                  {row.id === "services" && props.startupError && (
                    <p role="alert" className="guided-error">
                      {props.startupError}
                    </p>
                  )}
                  {row.id === "engines" &&
                    row.details.length > 0 &&
                    (row.details[0]?.code === "no-optional-computers" ? (
                      <p>{guidedSetupText.noComputers}</p>
                    ) : (
                      <ul className="guided-targets">
                        {row.details
                          .filter((detail) => detail.code.startsWith("target-"))
                          .map((detail, index) => (
                            <li key={`${detail.code}-${index}`}>
                              <span>{detail.text}</span>
                              {" — "}
                              <span>
                                {detail.code === "target-connected"
                                  ? guidedSetupText.connected
                                  : detail.code === "target-discovered"
                                    ? guidedSetupText.foundUnchecked
                                    : detail.code === "target-unavailable"
                                      ? guidedSetupText.unavailable
                                      : guidedSetupText.unknown}
                              </span>
                            </li>
                          ))}
                      </ul>
                    ))}
                  {row.status === "waiting-input" && row.id === "command" && (
                    <div className="guided-row-actions">
                      <Button type="button" onClick={() => props.onRetry(row.id)}>
                        {guidedSetupText.retry}
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        className="guided-secondary"
                        onClick={() => props.onSkip(row.id)}
                      >
                        {guidedSetupText.skip}
                      </Button>
                    </div>
                  )}
                  {row.status === "waiting-input" &&
                    (row.id === "services" || row.id === "engines") && (
                      <div className="guided-row-actions">
                        <Button type="button" onClick={() => props.onRetry(row.id)}>
                          {guidedSetupText.continue}
                        </Button>
                        {row.id === "engines" && (
                          <Button
                            type="button"
                            variant="secondary"
                            className="guided-secondary"
                            onClick={() => props.onSkip(row.id)}
                          >
                            {guidedSetupText.skip}
                          </Button>
                        )}
                      </div>
                    )}
                  {row.status === "failed" && !stopFailed && !newerJournal && (
                    <div className="guided-row-actions">
                      <Button ref={failureRef} type="button" onClick={() => props.onRetry(row.id)}>
                        {guidedSetupText.retry}
                      </Button>
                      {row.id === "command" && (
                        <Button
                          type="button"
                          variant="secondary"
                          className="guided-secondary"
                          onClick={() => props.onSkip(row.id)}
                        >
                          {guidedSetupText.skip}
                        </Button>
                      )}
                    </div>
                  )}
                  {row.waitingElapsedMs > 0 && (
                    <p className="guided-time" aria-hidden="true">
                      {guidedSetupText.waitingTime}: {formatSetupDuration(row.waitingElapsedMs)}
                    </p>
                  )}
                  {canDetails && expanded === row.id && (
                    <div id={`guided-details-${row.id}`} className="guided-details">
                      <p>
                        {guidedSetupText.activeTime}: {formatSetupDuration(row.activeElapsedMs)}
                      </p>
                      <textarea
                        aria-label={guidedSetupText.detailsLabel}
                        readOnly
                        value={details}
                      />
                      <Button
                        type="button"
                        variant="secondary"
                        className="guided-secondary"
                        onClick={async () => {
                          setCopyMessage(
                            (await props.onCopyDetails(details))
                              ? guidedSetupText.copied
                              : guidedSetupText.copyFailed,
                          );
                        }}
                      >
                        {guidedSetupText.copyDetails}
                      </Button>
                      {copyMessage && <p role="status">{copyMessage}</p>}
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <div className="guided-actions">
        {stopFailed ? (
          <Button type="button" onClick={props.onCancel}>
            {guidedSetupText.retryStop}
          </Button>
        ) : snapshot.interrupted ? (
          <>
            <Button type="button" onClick={props.onResume}>
              {guidedSetupText.resume}
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="guided-secondary"
              onClick={props.onClose}
            >
              {guidedSetupText.close}
            </Button>
          </>
        ) : newerJournal ? (
          <Button type="button" onClick={props.onClose}>
            {guidedSetupText.close}
          </Button>
        ) : !started || cancelled ? (
          <Button type="button" onClick={props.onStart}>
            {guidedSetupText.start}
          </Button>
        ) : pilotReady ? (
          <Button type="button" onClick={props.onContinue}>
            {guidedSetupText.continue}
          </Button>
        ) : null}
        {started && !snapshot.interrupted && !newerJournal && !stopFailed && !stopping && (
          <Button
            type="button"
            variant="secondary"
            className="guided-secondary"
            onClick={props.onCancel}
          >
            {guidedSetupText.cancel}
          </Button>
        )}
      </div>
    </section>
  );
}
