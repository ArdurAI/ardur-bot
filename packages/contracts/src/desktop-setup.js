import { z } from "zod";

export const SetupStepIdSchema = z.enum([
  "prerequisites",
  "database",
  "migrations",
  "command",
  "services",
  "engines",
  "model",
  "first-bot",
  "finish",
]);

export const SetupStepStatusSchema = z.enum([
  "pending",
  "checking",
  "running",
  "waiting-input",
  "verifying",
  "succeeded",
  "skipped",
  "not-applicable",
  "cancelling",
  "cancelled",
  "failed",
  "interrupted",
]);

const boundedText = z.string().max(240);
export const SetupDetailSchema = z.object({ code: boundedText, text: boundedText }).strict();

export const SetupStepSnapshotSchema = z
  .object({
    id: SetupStepIdSchema,
    available: z.boolean(),
    revision: z.number().int().nonnegative(),
    attempt: z.number().int().nonnegative(),
    status: SetupStepStatusSchema,
    activeElapsedMs: z.number().finite().nonnegative(),
    waitingElapsedMs: z.number().finite().nonnegative(),
    verifiedAt: z.number().finite().nonnegative().nullable(),
    reasonCode: boundedText.nullable(),
    details: z.array(SetupDetailSchema).max(12),
  })
  .strict();

export const SetupSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    planVersion: z.literal(1),
    runId: z.string().uuid(),
    sequence: z.number().int().nonnegative(),
    mode: z.literal("local"),
    steps: z.array(SetupStepSnapshotSchema).length(9),
    currentStep: SetupStepIdSchema.nullable(),
    machineReady: z.boolean(),
    accountReady: z.boolean(),
    complete: z.boolean(),
    interrupted: z.boolean(),
    blocked: z.boolean(),
  })
  .strict();

export const SetupStepInputSchema = SetupStepIdSchema;
export const SetupNoInputSchema = z.tuple([]);
export const SetupSnapshotOutputSchema = SetupSnapshotSchema;
export const SetupOnChangeOutputSchema = SetupSnapshotSchema;
export const StepReceiptSchema = z
  .object({ kind: z.enum(["owned", "reused", "verified"]), proof: z.string().max(120) })
  .strict();
export const SetupJournalSchema = z
  .object({
    version: z.literal(1),
    snapshot: SetupSnapshotSchema,
    pending: z.object({ stepId: SetupStepIdSchema, runId: z.string().uuid() }).strict().nullable(),
    receipts: z.partialRecord(SetupStepIdSchema, StepReceiptSchema),
  })
  .strict();
export const GUIDED_SETUP_CHANNELS = {
  snapshot: "desktop.guidedSetup.snapshot",
  start: "desktop.guidedSetup.start",
  retry: "desktop.guidedSetup.retry",
  skip: "desktop.guidedSetup.skip",
  cancel: "desktop.guidedSetup.cancel",
  resume: "desktop.guidedSetup.resume",
  changed: "desktop.guidedSetup.changed",
  startup: "desktop.guidedSetup.startup",
  startupState: "desktop.guidedSetup.startupState",
  openAgain: "desktop.guidedSetup.openAgain",
  openModels: "desktop.guidedSetup.openModels",
  createBot: "desktop.guidedSetup.createBot",
  openApp: "desktop.guidedSetup.openApp",
  returnToSetup: "desktop.guidedSetup.returnToSetup",
  refreshAccount: "desktop.guidedSetup.refreshAccount",
};
