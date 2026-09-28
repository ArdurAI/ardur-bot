import type { ZodType } from "zod";

export type SetupStepId =
  | "prerequisites"
  | "database"
  | "migrations"
  | "command"
  | "services"
  | "engines"
  | "model"
  | "first-bot"
  | "finish";
export type SetupStepStatus =
  | "pending"
  | "checking"
  | "running"
  | "waiting-input"
  | "verifying"
  | "succeeded"
  | "skipped"
  | "not-applicable"
  | "cancelling"
  | "cancelled"
  | "failed"
  | "interrupted";
export interface SetupDetail {
  code: string;
  text: string;
}
export interface SetupStepSnapshot {
  id: SetupStepId;
  available: boolean;
  revision: number;
  attempt: number;
  status: SetupStepStatus;
  activeElapsedMs: number;
  waitingElapsedMs: number;
  verifiedAt: number | null;
  reasonCode: string | null;
  details: SetupDetail[];
}
export interface SetupSnapshot {
  schemaVersion: 1;
  planVersion: 1;
  runId: string;
  sequence: number;
  mode: "local";
  steps: SetupStepSnapshot[];
  currentStep: SetupStepId | null;
  machineReady: boolean;
  accountReady: boolean;
  complete: boolean;
  interrupted: boolean;
  blocked: boolean;
}
export interface StepReceipt {
  kind: "owned" | "reused" | "verified";
  proof: string;
}
export interface SetupJournal {
  version: 1;
  snapshot: SetupSnapshot;
  pending: { stepId: SetupStepId; runId: string } | null;
  receipts: Partial<Record<SetupStepId, StepReceipt>>;
}

export const SetupStepIdSchema: ZodType<SetupStepId>;
export const SetupStepStatusSchema: ZodType<SetupStepStatus>;
export const SetupDetailSchema: ZodType<SetupDetail>;
export const SetupStepSnapshotSchema: ZodType<SetupStepSnapshot>;
export const SetupSnapshotSchema: ZodType<SetupSnapshot>;
export const SetupStepInputSchema: typeof SetupStepIdSchema;
export const SetupNoInputSchema: ZodType<[]>;
export const SetupSnapshotOutputSchema: typeof SetupSnapshotSchema;
export const SetupOnChangeOutputSchema: typeof SetupSnapshotSchema;
export const StepReceiptSchema: ZodType<StepReceipt>;
export const SetupJournalSchema: ZodType<SetupJournal>;
export const GUIDED_SETUP_CHANNELS: {
  readonly snapshot: "desktop.guidedSetup.snapshot";
  readonly start: "desktop.guidedSetup.start";
  readonly retry: "desktop.guidedSetup.retry";
  readonly skip: "desktop.guidedSetup.skip";
  readonly cancel: "desktop.guidedSetup.cancel";
  readonly resume: "desktop.guidedSetup.resume";
  readonly changed: "desktop.guidedSetup.changed";
  readonly startup: "desktop.guidedSetup.startup";
  readonly startupState: "desktop.guidedSetup.startupState";
  readonly openAgain: "desktop.guidedSetup.openAgain";
  readonly openModels: "desktop.guidedSetup.openModels";
  readonly createBot: "desktop.guidedSetup.createBot";
  readonly openApp: "desktop.guidedSetup.openApp";
  readonly returnToSetup: "desktop.guidedSetup.returnToSetup";
  readonly refreshAccount: "desktop.guidedSetup.refreshAccount";
};

export interface GuidedSetupBridge {
  snapshot(): Promise<SetupSnapshot>;
  start(): Promise<SetupSnapshot>;
  retry(stepId: SetupStepId): Promise<SetupSnapshot>;
  skip(stepId: SetupStepId): Promise<SetupSnapshot>;
  cancel(): Promise<SetupSnapshot>;
  resume(): Promise<SetupSnapshot>;
  setStartup(enabled: boolean): Promise<{ ok: boolean; enabled?: boolean; error?: string }>;
  getStartup(): Promise<{ supported: boolean; enabled: boolean }>;
  openModels(): Promise<void>;
  createBot(): Promise<void>;
  openApp(): Promise<void>;
  onChange(listener: (snapshot: SetupSnapshot) => void): () => void;
}
