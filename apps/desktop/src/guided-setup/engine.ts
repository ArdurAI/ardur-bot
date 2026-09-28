import { randomUUID } from "node:crypto";
import type {
  SetupDetail,
  SetupSnapshot,
  SetupStepId,
  SetupStepSnapshot,
  SetupStepStatus,
} from "@ardurbot/contracts/desktop-setup";
import type { SetupJournal, SetupJournalStore, StepReceipt } from "./store.js";
import { freshJournal } from "./store.js";

export const SETUP_ORDER: readonly SetupStepId[] = [
  "prerequisites",
  "database",
  "migrations",
  "command",
  "services",
  "engines",
  "model",
  "first-bot",
  "finish",
];
export interface SetupContext {
  runId: string;
}
export type StepVerification =
  | { kind: "satisfied"; checkedAt: number; evidence: string; details?: SetupDetail[] }
  | { kind: "needed"; reasonCode: string; details?: SetupDetail[] }
  | { kind: "blocked"; reasonCode: string; details?: SetupDetail[] }
  | { kind: "notApplicable"; reasonCode: string; details?: SetupDetail[] };
export interface SetupStep {
  id: SetupStepId;
  revision: number;
  requires: readonly SetupStepId[];
  canSkip: boolean;
  waitForInput?: boolean;
  check(context: SetupContext, signal: AbortSignal): Promise<StepVerification>;
  recheck?(context: SetupContext, signal: AbortSignal): Promise<StepVerification>;
  run(context: SetupContext, signal: AbortSignal): Promise<StepReceipt>;
  verify(
    context: SetupContext,
    receipt: StepReceipt,
    signal: AbortSignal,
  ): Promise<StepVerification>;
  /** Return steps whose verified resources were stopped by cleanup. */
  cancel(
    context: SetupContext,
    receipt: StepReceipt | null,
  ): Promise<readonly SetupStepId[] | undefined>;
  rollback?(context: SetupContext, receipt: StepReceipt | null): Promise<void>;
}
export interface SetupClock {
  monotonic(): number;
  wall(): number;
}
const systemClock: SetupClock = { monotonic: () => performance.now(), wall: () => Date.now() };

function emptySnapshot(steps: readonly SetupStep[]): SetupSnapshot {
  return {
    schemaVersion: 1,
    planVersion: 1,
    runId: randomUUID(),
    sequence: 0,
    mode: "local",
    steps: SETUP_ORDER.map((id) => ({
      id,
      available: steps.some((step) => step.id === id),
      revision: steps.find((step) => step.id === id)?.revision ?? 0,
      attempt: 0,
      status: "pending",
      activeElapsedMs: 0,
      waitingElapsedMs: 0,
      verifiedAt: null,
      reasonCode: null,
      details: [],
    })),
    currentStep: null,
    machineReady: false,
    accountReady: false,
    complete: false,
    interrupted: false,
    blocked: false,
  };
}

const ACTIVE = new Set<SetupStepStatus>(["checking", "running", "verifying", "cancelling"]);
class JournalWriteError extends Error {}
export class SetupStepFailure extends Error {
  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}
export class SetupEngine {
  private journal: SetupJournal;
  private readonly steps: readonly SetupStep[];
  private readonly listeners = new Set<(snapshot: SetupSnapshot) => void>();
  private readonly freshlyVerified = new Set<SetupStepId>();
  private inflight: Promise<SetupSnapshot> | null = null;
  private cancelFlight: Promise<SetupSnapshot> | null = null;
  private abort: AbortController | null = null;
  private activeReceipt: { stepId: SetupStepId; receipt: StepReceipt } | null = null;
  private cancelling = false;
  private phaseStarted = 0;
  private writeQueue: Promise<void> = Promise.resolve();
  private newer = false;

  private constructor(
    private readonly store: SetupJournalStore,
    steps: readonly SetupStep[],
    private readonly clock: SetupClock,
  ) {
    this.steps = steps;
    this.journal = freshJournal(emptySnapshot(steps));
  }

  static async open(
    store: SetupJournalStore,
    steps: readonly SetupStep[],
    clock: SetupClock = systemClock,
  ): Promise<SetupEngine> {
    const engine = new SetupEngine(store, steps, clock);
    const loaded = await store.load();
    if (loaded.kind === "newer") {
      engine.newer = true;
      engine.journal.snapshot.blocked = true;
      engine.journal.snapshot.steps[0]!.status = "failed";
      engine.journal.snapshot.steps[0]!.reasonCode = "newer-journal";
      engine.journal.snapshot.steps[0]!.details = [
        { code: "newer-journal", text: "Update Ardur before continuing setup." },
      ];
    } else if (loaded.kind === "loaded") {
      engine.journal = loaded.journal;
      const snap = engine.journal.snapshot;
      for (const row of snap.steps) {
        const implementation = steps.find((step) => step.id === row.id);
        row.available = implementation !== undefined;
        row.revision = implementation?.revision ?? 0;
        if (ACTIVE.has(row.status) || row.status === "cancelling") {
          row.status = "interrupted";
          row.reasonCode = "setup-interrupted";
          snap.interrupted = true;
        }
      }
      if (engine.journal.pending) {
        const row = snap.steps.find((item) => item.id === engine.journal.pending?.stepId);
        if (row) {
          if (row.reasonCode !== "cleanup-incomplete") {
            row.status = "interrupted";
            row.reasonCode = "setup-interrupted";
          }
        }
        snap.interrupted = true;
      }
      // Every saved success is checked again before another run can depend on it.
      snap.complete = false;
      snap.machineReady = false;
    } else if (loaded.kind === "corrupt") {
      engine.journal.snapshot.interrupted = true;
      engine.journal.snapshot.steps[0]!.reasonCode = "journal-unreadable";
    }
    return engine;
  }

  snapshot(): SetupSnapshot {
    return structuredClone(this.journal.snapshot);
  }
  running(): boolean {
    return this.inflight !== null || this.cancelFlight !== null;
  }
  /** A saved row is never enough to authorize the service handoff after a restart. */
  pilotReady(): boolean {
    if (
      this.inflight ||
      this.cancelFlight ||
      this.cancelling ||
      this.newer ||
      this.cleanupPending()
    )
      return false;
    if (this.journal.snapshot.interrupted) return false;
    const required = ["prerequisites", "database", "migrations", "services"] as const;
    if (
      !required.every((id) => this.row(id).status === "succeeded" && this.freshlyVerified.has(id))
    )
      return false;
    const command = this.row("command");
    const engines = this.row("engines");
    return (
      (command.status === "skipped" ||
        command.status === "not-applicable" ||
        (command.status === "succeeded" && this.freshlyVerified.has("command"))) &&
      (engines.status === "skipped" ||
        (engines.status === "succeeded" && this.freshlyVerified.has("engines")))
    );
  }
  onChange(listener: (snapshot: SetupSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Late asynchronous discoveries may only update the attempt that requested them. */
  publishFor(runId: string, stepId: SetupStepId, details: SetupDetail[]): boolean {
    if (runId !== this.journal.snapshot.runId || this.cancelling) return false;
    const row = this.row(stepId);
    if (!ACTIVE.has(row.status)) return false;
    row.details = details.slice(0, 12);
    this.journal.snapshot.sequence += 1;
    this.emit();
    return true;
  }

  start(): Promise<SetupSnapshot> {
    if (this.inflight) return this.inflight;
    if (this.newer || this.cancelling || this.journal.snapshot.interrupted || this.cleanupPending())
      return Promise.resolve(this.snapshot());
    return this.schedule(0, false);
  }

  resume(): Promise<SetupSnapshot> {
    if (this.inflight) return this.inflight;
    if (this.newer || this.cancelling || this.cleanupPending())
      return Promise.resolve(this.snapshot());
    this.journal.snapshot.interrupted = false;
    return this.schedule(0, false);
  }

  retry(stepId: SetupStepId): Promise<SetupSnapshot> {
    if (this.inflight) return this.inflight;
    if (this.newer || this.cancelling || this.journal.snapshot.interrupted || this.cleanupPending())
      return Promise.resolve(this.snapshot());
    const index = this.steps.findIndex((step) => step.id === stepId);
    if (index < 0) return Promise.resolve(this.snapshot());
    if (this.row(stepId).reasonCode === "journal-write-failed")
      this.journal.snapshot.blocked = false;
    return this.schedule(index, true, this.steps.length, true);
  }

  async skip(stepId: SetupStepId): Promise<SetupSnapshot> {
    if (
      this.inflight ||
      this.newer ||
      this.cancelling ||
      this.journal.snapshot.interrupted ||
      this.cleanupPending()
    )
      return this.snapshot();
    const step = this.steps.find((entry) => entry.id === stepId);
    if (!step?.canSkip) return this.snapshot();
    const index = this.steps.indexOf(step);
    if (!(await this.recheckDependencies(step, index))) return this.snapshot();
    const row = this.row(stepId);
    if (row.status === "succeeded") return this.snapshot();
    this.transition(stepId, "skipped", "user-skipped");
    if (this.journal.pending?.stepId === stepId) this.journal.pending = null;
    await this.persist();
    return this.schedule(index + 1, false);
  }

  cancel(): Promise<SetupSnapshot> {
    if (this.cancelFlight) return this.cancelFlight;
    const stopping = this.cancelNow().finally(() => {
      if (this.cancelFlight === stopping) this.cancelFlight = null;
    });
    this.cancelFlight = stopping;
    return stopping;
  }

  private async cancelNow(): Promise<SetupSnapshot> {
    if (this.newer) return this.snapshot();
    this.cancelling = true;
    const current = this.journal.snapshot.currentStep;
    if (current) this.transition(current, "cancelling", "stopping-safely");
    try {
      await this.persist();
    } catch {
      this.abort?.abort();
      await this.inflight?.catch(() => undefined);
      const step = current ? this.steps.find((item) => item.id === current) : undefined;
      const receipt = current ? this.receiptFor(current) : null;
      let cleaned = true;
      try {
        const invalidated = await step?.cancel({ runId: this.journal.snapshot.runId }, receipt);
        if (invalidated) this.invalidate(invalidated);
      } catch {
        cleaned = false;
      }
      this.failInMemory(current, cleaned === false ? "cleanup-incomplete" : "journal-write-failed");
      this.cancelling = false;
      return this.snapshot();
    }
    this.abort?.abort();
    await this.inflight?.catch(() => undefined);
    if (current) {
      const step = this.steps.find((item) => item.id === current);
      const receipt = this.receiptFor(current);
      try {
        const invalidated = await step?.cancel({ runId: this.journal.snapshot.runId }, receipt);
        if (invalidated) this.invalidate(invalidated);
        if (this.journal.pending?.stepId === current)
          await step?.rollback?.({ runId: this.journal.snapshot.runId }, receipt);
      } catch {
        this.failInMemory(current, "cleanup-incomplete");
        this.journal.snapshot.blocked = true;
        await this.persist().catch(() => undefined);
        this.cancelling = false;
        return this.snapshot();
      }
      this.transition(current, "cancelled", "stopped");
    }
    if (this.journal.pending?.stepId === current) this.journal.pending = null;
    this.activeReceipt = null;
    this.journal.snapshot.blocked = false;
    this.journal.snapshot.interrupted = false;
    this.journal.snapshot.currentStep = null;
    this.journal.snapshot.runId = randomUUID();
    await this.persist().catch(() => this.failInMemory(current, "journal-write-failed"));
    this.cancelling = false;
    return this.snapshot();
  }

  private schedule(
    startIndex: number,
    explicit: boolean,
    stopBefore = this.steps.length,
    retry = false,
  ): Promise<SetupSnapshot> {
    if (this.inflight) return this.inflight;
    const controller = new AbortController();
    this.abort = controller;
    const runId = randomUUID();
    this.journal.snapshot.runId = runId;
    const execution = retry
      ? this.executeRetry(startIndex, controller.signal)
      : this.execute(startIndex, explicit, controller.signal, stopBefore);
    const running = execution.finally(() => {
      if (this.inflight === running) {
        this.inflight = null;
        this.abort = null;
      }
    });
    this.inflight = running;
    return running;
  }

  private async executeRetry(index: number, signal: AbortSignal): Promise<SetupSnapshot> {
    const step = this.steps[index]!;
    if (!this.dependenciesMet(step)) {
      await this.execute(0, false, signal, index);
      if (
        signal.aborted ||
        this.cancelling ||
        this.journal.snapshot.interrupted ||
        this.cleanupPending() ||
        !this.dependenciesMet(step)
      )
        return this.snapshot();
    }
    if (signal.aborted || this.cancelling) return this.snapshot();
    if (step.id === "migrations") {
      const databaseIndex = this.steps.findIndex((item) => item.id === "database");
      if (databaseIndex >= 0) {
        this.freshlyVerified.delete("database");
        return this.execute(databaseIndex, false, signal, this.steps.length);
      }
    }
    return this.execute(index, true, signal, this.steps.length);
  }

  private async execute(
    startIndex: number,
    explicit: boolean,
    signal: AbortSignal,
    stopBefore: number,
  ): Promise<SetupSnapshot> {
    try {
      for (let index = startIndex; index < stopBefore; index++) {
        const step = this.steps[index]!;
        if (signal.aborted || this.cancelling) break;
        if (!this.dependenciesMet(step)) break;
        const row = this.row(step.id);
        if (!explicit && row.status === "succeeded" && this.freshlyVerified.has(step.id)) continue;
        const savedSuccess = row.status === "succeeded";
        const previouslySkipped = row.status === "skipped" && !explicit;
        this.journal.snapshot.currentStep = step.id;
        row.attempt += 1;
        this.transition(step.id, "checking", null);
        await this.persist();
        if (signal.aborted || this.cancelling) break;
        const context = { runId: this.journal.snapshot.runId };
        const checked = await (savedSuccess && step.recheck
          ? step.recheck(context, signal)
          : step.check(context, signal));
        if (signal.aborted || this.cancelling) break;
        if (checked.kind === "satisfied") {
          this.success(step, checked, "already-ready");
          if (this.journal.pending?.stepId === step.id) this.journal.pending = null;
          if (
            !this.journal.receipts[step.id] ||
            (step.id === "services" && this.journal.receipts[step.id]?.proof !== checked.evidence)
          )
            this.journal.receipts[step.id] = { kind: "verified", proof: checked.evidence };
          await this.persist();
          explicit = false;
          continue;
        }
        if (checked.kind === "notApplicable") {
          this.transition(step.id, "not-applicable", checked.reasonCode, checked.details);
          await this.persist();
          explicit = false;
          continue;
        }
        if (previouslySkipped) {
          this.transition(step.id, "skipped", "user-skipped");
          await this.persist();
          continue;
        }
        if (checked.kind === "blocked") {
          this.transition(step.id, "failed", checked.reasonCode, checked.details);
          await this.persist();
          break;
        }
        if ((step.canSkip || step.waitForInput) && !explicit) {
          this.transition(step.id, "waiting-input", checked.reasonCode, checked.details);
          await this.persist();
          break;
        }
        this.journal.pending = { stepId: step.id, runId: context.runId };
        delete this.journal.receipts[step.id];
        this.activeReceipt = null;
        this.transition(step.id, "running", checked.reasonCode, checked.details);
        await this.persist(); // Intent is durable before the first mutation.
        if (signal.aborted || this.cancelling) break;
        const receipt = await step.run(context, signal);
        this.activeReceipt = { stepId: step.id, receipt };
        if (signal.aborted || this.cancelling) break;
        this.transition(step.id, "verifying", null);
        await this.persist();
        if (signal.aborted || this.cancelling) break;
        const verified = await step.verify(context, receipt, signal);
        if (signal.aborted || this.cancelling) break;
        if (verified.kind !== "satisfied") {
          const reason = "reasonCode" in verified ? verified.reasonCode : "verification-failed";
          this.transition(
            step.id,
            verified.kind === "needed" ? "waiting-input" : "failed",
            reason,
            verified.details,
          );
          await this.persist();
          break;
        }
        this.journal.receipts[step.id] = receipt;
        this.activeReceipt = null;
        this.journal.pending = null;
        this.success(step, verified, null);
        await this.persist(); // Receipt is durable before success is emitted.
        explicit = false;
      }
    } catch (error) {
      if (!this.cancelling && !signal.aborted) {
        const current = this.journal.snapshot.currentStep;
        this.failInMemory(
          current,
          error instanceof JournalWriteError
            ? "journal-write-failed"
            : error instanceof SetupStepFailure
              ? error.reasonCode
              : "setup-step-failed",
        );
        await this.persist().catch(() => this.failInMemory(current, "journal-write-failed"));
      }
    }
    return this.snapshot();
  }

  private success(
    step: SetupStep,
    checked: Extract<StepVerification, { kind: "satisfied" }>,
    reason: string | null,
  ): void {
    const row = this.row(step.id);
    this.transition(step.id, "succeeded", reason, checked.details);
    row.verifiedAt = checked.checkedAt;
    this.freshlyVerified.add(step.id);
    this.journal.snapshot.machineReady = [
      "prerequisites",
      "database",
      "migrations",
      "services",
    ].every((id) => this.row(id as SetupStepId).status === "succeeded");
  }
  private dependenciesMet(step: SetupStep): boolean {
    return step.requires.every(
      (id) => this.row(id).status === "succeeded" && this.freshlyVerified.has(id),
    );
  }
  private async recheckDependencies(step: SetupStep, stopBefore: number): Promise<boolean> {
    if (this.dependenciesMet(step)) return true;
    if (step.requires.some((id) => this.row(id).status !== "succeeded")) return false;
    await this.schedule(0, false, stopBefore);
    return (
      !this.cancelling &&
      !this.journal.snapshot.interrupted &&
      !this.cleanupPending() &&
      this.dependenciesMet(step)
    );
  }
  private row(id: SetupStepId): SetupStepSnapshot {
    return this.journal.snapshot.steps.find((item) => item.id === id)!;
  }
  private receiptFor(id: SetupStepId): StepReceipt | null {
    return this.activeReceipt?.stepId === id
      ? this.activeReceipt.receipt
      : (this.journal.receipts[id] ?? null);
  }
  private invalidate(stepIds: readonly SetupStepId[]): void {
    for (const id of stepIds) {
      const row = this.row(id);
      this.freshlyVerified.delete(id);
      delete this.journal.receipts[id];
      row.status = "pending";
      row.verifiedAt = null;
      row.reasonCode = null;
      row.details = [];
    }
    this.journal.snapshot.machineReady = false;
    this.journal.snapshot.complete = false;
  }
  private cleanupPending(): boolean {
    return this.journal.snapshot.steps.some((row) => row.reasonCode === "cleanup-incomplete");
  }
  private transition(
    id: SetupStepId,
    status: SetupStepStatus,
    reasonCode: string | null,
    details?: SetupDetail[],
  ): void {
    const row = this.row(id);
    const now = this.clock.monotonic();
    const delta = Math.max(0, now - this.phaseStarted);
    if (this.journal.snapshot.currentStep === id && this.phaseStarted > 0) {
      if (ACTIVE.has(row.status)) row.activeElapsedMs += delta;
      else if (row.status === "waiting-input") row.waitingElapsedMs += delta;
    }
    row.status = status;
    row.reasonCode = reasonCode;
    row.details = details?.slice(0, 12) ?? [];
    this.phaseStarted = now;
  }
  private failInMemory(id: SetupStepId | null, reason: string): void {
    if (id) this.transition(id, "failed", reason);
    this.journal.snapshot.blocked =
      reason === "cleanup-incomplete" || reason === "journal-write-failed";
    this.emit();
  }
  private async persist(): Promise<void> {
    this.journal.snapshot.sequence += 1;
    const value = structuredClone(this.journal);
    const write = this.writeQueue.then(() => this.store.save(value));
    this.writeQueue = write.catch(() => undefined);
    try {
      await write;
    } catch {
      throw new JournalWriteError();
    }
    if (!this.cancelling || value.snapshot.steps.some((row) => row.status === "cancelling"))
      this.emit();
  }
  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
