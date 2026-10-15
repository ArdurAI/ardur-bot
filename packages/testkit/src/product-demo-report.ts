import { writeFile } from "node:fs/promises";

export const PRODUCT_DEMO_STEPS = [
  {
    id: "models",
    label: "Settings → Models: a connected model shows its context limit and source.",
    depends: [],
  },
  {
    id: "default-reply",
    label: "Create a bot on This computer with the default model → first reply under 20 s.",
    depends: ["models"],
  },
  { id: "native-reply", label: "Create a bot on Hermes → first reply.", depends: ["models"] },
  {
    id: "draft-pr",
    label: "Give the builder bot a GitHub issue → it opens a draft PR with a timing table.",
    depends: ["default-reply"],
  },
  {
    id: "chief-summary",
    label: "Chief: ask for a Notion page summary → tools reviewed once, then it answers.",
    depends: ["models"],
  },
  {
    id: "workspace",
    label: "Side panel: open IDE and Recorded changes for the builder bot.",
    depends: ["default-reply"],
  },
  {
    id: "room",
    label: "Room with two bots: both answer; note the gap between them.",
    depends: ["models"],
  },
] as const;
export type ProductDemoStepId = (typeof PRODUCT_DEMO_STEPS)[number]["id"];
export type ProductDemoMode = "scripted" | "live";
export type ProductDemoMissing =
  | "host-computer"
  | "native-runtime"
  | "github"
  | "integration"
  | "not-executed";
type Reason = ProductDemoMissing | "dependency-skipped" | "action-failed";
export type ProductDemoObservation = {
  screenshot: string;
  evidence: "app-api" | "fixture-receipt" | "manual";
  replyGapMs?: number;
};
export type ProductDemoResult = {
  id: ProductDemoStepId;
  result: "passed" | "failed" | "skipped";
  startMs: number;
  endMs: number;
  elapsedMs: number | null;
  screenshot: string | null;
  evidence: ProductDemoObservation["evidence"] | null;
  reason: Reason | null;
  missingPrerequisite: ProductDemoMissing | null;
  replyGapMs: number | null;
};
export type ProductDemoReport = {
  schemaVersion: 1;
  label: "Product demo";
  mode: ProductDemoMode;
  buildRevision: string;
  buildDirty: boolean;
  scope: "scripted-application-behavior" | "manual-live-observation";
  execution: "observed" | "not-executed";
  comparativeSpeedClaim: false;
  selfBuildClaim: false;
  steps: ProductDemoResult[];
};
const finite = (value: number) => Number.isFinite(value) && value >= 0;

/** Fixed fields and codes deliberately exclude prompts, raw failures and arbitrary metadata. */
export class ProductDemoRecorder {
  private readonly results: ProductDemoResult[] = [];
  private readonly origin: number;
  private last = 0;
  private pending = false;
  private readonly input: {
    mode: ProductDemoMode;
    buildRevision: string;
    buildDirty: boolean;
    now?: () => number;
  };
  constructor(input: ProductDemoRecorder["input"]) {
    this.input = {
      mode: input.mode,
      buildRevision: input.buildRevision,
      buildDirty: input.buildDirty,
      now: input.now,
    };
    if (
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.buildRevision) ||
      !["scripted", "live"].includes(input.mode) ||
      typeof input.buildDirty !== "boolean"
    )
      throw new Error("Invalid product demo provenance");
    this.origin = (input.now ?? (() => performance.now()))();
    if (!finite(this.origin)) throw new Error("Invalid product demo clock");
  }
  private offset() {
    const value = (this.input.now ?? (() => performance.now()))() - this.origin;
    if (!finite(value) || value < this.last) throw new Error("Product demo clock moved backwards");
    this.last = value;
    return value;
  }
  async step(
    id: ProductDemoStepId,
    action: () => Promise<ProductDemoObservation>,
    missing?: ProductDemoMissing,
  ) {
    const definition = PRODUCT_DEMO_STEPS[this.results.length];
    if (this.pending || !definition || definition.id !== id)
      throw new Error("Product demo steps are ordered and single-flight");
    if (
      missing &&
      !["host-computer", "native-runtime", "github", "integration", "not-executed"].includes(
        missing,
      )
    )
      throw new Error("Invalid product demo prerequisite");
    this.pending = true;
    try {
      const startMs = this.offset();
      const blocked = definition.depends.some(
        (dependency) =>
          !this.results.some((step) => step.id === dependency && step.result === "passed"),
      );
      let result: ProductDemoResult["result"] = "skipped";
      let reason: Reason | null = blocked ? "dependency-skipped" : (missing ?? null);
      let observation: ProductDemoObservation | null = null;
      if (!reason) {
        try {
          const value = await action();
          const { screenshot, evidence, replyGapMs } = value;
          if (
            screenshot !== `screenshots/${id}.png` ||
            !["app-api", "fixture-receipt", "manual"].includes(evidence) ||
            (replyGapMs !== undefined && (!finite(replyGapMs) || id !== "room")) ||
            (this.input.mode === "live" && evidence === "fixture-receipt") ||
            (this.input.mode === "scripted" && evidence === "manual")
          )
            throw new Error("Invalid product demo evidence");
          observation = { screenshot, evidence, replyGapMs };
          result = "passed";
        } catch {
          result = "failed";
          reason = "action-failed";
        }
      }
      const endMs = this.offset();
      const record: ProductDemoResult = {
        id,
        result,
        startMs,
        endMs,
        elapsedMs: result === "skipped" ? null : endMs - startMs,
        screenshot: observation?.screenshot ?? null,
        evidence: observation?.evidence ?? null,
        reason,
        missingPrerequisite: missing ?? null,
        replyGapMs: observation?.replyGapMs ?? null,
      };
      this.results.push(record);
      return { ...record };
    } finally {
      this.pending = false;
    }
  }
  report(): ProductDemoReport {
    if (this.pending || this.results.length !== PRODUCT_DEMO_STEPS.length)
      throw new Error("Product demo report requires all seven results");
    return {
      schemaVersion: 1,
      label: "Product demo",
      mode: this.input.mode,
      buildRevision: this.input.buildRevision,
      buildDirty: this.input.buildDirty,
      scope:
        this.input.mode === "scripted"
          ? "scripted-application-behavior"
          : "manual-live-observation",
      execution: this.results.some((row) => row.result !== "skipped") ? "observed" : "not-executed",
      comparativeSpeedClaim: false,
      selfBuildClaim: false,
      steps: this.results.map((row) => ({ ...row })),
    };
  }
}

export async function writeProductDemoReport(file: string, recorder: ProductDemoRecorder) {
  // Append-only invocation: never overwrite an earlier success with a later attempt.
  await writeFile(file, `${JSON.stringify(recorder.report(), null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}
