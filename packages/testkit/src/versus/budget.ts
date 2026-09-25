import { performance } from "node:perf_hooks";
import { contentDigest } from "../scoreboard/manifest.js";
import { getTask, immutable } from "../scoreboard/tasks/catalog.js";

export interface Limits {
  requests: number;
  logicalInput: number;
  output: number;
  totalTokens: number;
  wallMs: number;
  toolCalls: number;
  descendants: number;
}
export interface Budget {
  version: 1;
  endpoint: { origin: string; protocol: "ollama-openai"; paid: boolean };
  model: {
    id: string;
    digest: string;
    quantization: string;
    serverVersion: string;
    tokenizerHash: string;
    templateHash: string;
  };
  contextSize: number;
  maxOutputTokens: number;
  temperature: number;
  seed: number;
  concurrency: number;
  global: Limits;
  perTrial: Limits;
  resources: {
    memoryBytes: number;
    cpuMs: number;
    processes: number;
    sampleMs: number;
    diskBytes: number;
  };
  cohort: {
    tasks: string[];
    repetitions: number;
    history: "short" | "balanced";
    cacheState: string;
  };
  currency: {
    code: string;
    cap: number;
    priceSchedule: null | {
      version: string;
      date: string;
      source: string;
      modelDigest: string;
      inputPerMillion: number;
      outputPerMillion: number;
    };
  };
}

export function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function validateModelMetadataLabel(value: unknown, field: string): asserts value is string {
  requireValue(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 80 &&
      !/[^a-zA-Z0-9._-]/.test(value),
    `Invalid ${field}`,
  );
}
export function record(value: unknown): Record<string, unknown> {
  requireValue(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Expected object",
  );
  return value as Record<string, unknown>;
}
export function exactKeys(value: unknown, expected: readonly string[]) {
  const object = record(value);
  requireValue(
    Object.keys(object).sort().join("|") === [...expected].sort().join("|"),
    "Missing or unknown configuration fields",
  );
  return object;
}
export function positiveInteger(value: unknown, field: string): asserts value is number {
  requireValue(
    Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 1_000_000_000_000,
    `Finite positive bounded integer required: ${field}`,
  );
}
const limitKeys = [
  "requests",
  "logicalInput",
  "output",
  "totalTokens",
  "wallMs",
  "toolCalls",
  "descendants",
] as const;
function validateLimits(value: unknown): Limits {
  const object = exactKeys(value, limitKeys);
  for (const key of limitKeys) positiveInteger(object[key], key);
  const limits = object as unknown as Limits;
  requireValue(
    limits.logicalInput <= limits.totalTokens && limits.output <= limits.totalTokens,
    "Token limits inconsistent",
  );
  requireValue(Number.isSafeInteger(limits.logicalInput + limits.output), "Token limit overflow");
  requireValue(limits.wallMs <= 2_147_483_647, "Wall limit exceeds timer range");
  return limits;
}
export function parseBudget(value: unknown): Budget {
  const object = exactKeys(value, [
    "version",
    "endpoint",
    "model",
    "contextSize",
    "maxOutputTokens",
    "temperature",
    "seed",
    "concurrency",
    "global",
    "perTrial",
    "resources",
    "cohort",
    "currency",
  ]);
  requireValue(object.version === 1, "Unknown budget version");
  const endpoint = exactKeys(object.endpoint, ["origin", "protocol", "paid"]);
  requireValue(typeof endpoint.origin === "string", "Endpoint origin required");
  const url = new URL(endpoint.origin);
  requireValue(
    url.origin === endpoint.origin && !url.username && !url.password && !url.search && !url.hash,
    "Endpoint must be a credential-free origin",
  );
  requireValue(
    endpoint.protocol === "ollama-openai" && typeof endpoint.paid === "boolean",
    "Unknown endpoint protocol",
  );
  requireValue(
    endpoint.paid
      ? url.protocol === "https:"
      : url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname),
    "Local endpoint requires numeric loopback; paid endpoint requires HTTPS",
  );
  const model = exactKeys(object.model, [
    "id",
    "digest",
    "quantization",
    "serverVersion",
    "tokenizerHash",
    "templateHash",
  ]);
  requireValue(
    typeof model.id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,199}$/.test(model.id),
    "Invalid model identity",
  );
  for (const field of ["digest", "tokenizerHash", "templateHash"])
    requireValue(
      typeof model[field] === "string" && /^(?!0{64})[a-f0-9]{64}$/.test(model[field] as string),
      `Model ${field} must be a nonzero SHA-256`,
    );
  for (const field of ["quantization", "serverVersion"])
    validateModelMetadataLabel(model[field], field);
  for (const field of ["contextSize", "maxOutputTokens", "concurrency"])
    positiveInteger(object[field], field);
  requireValue(
    Number(object.maxOutputTokens) < Number(object.contextSize) &&
      Number(object.contextSize) <= 1_000_000,
    "Invalid context/output window",
  );
  requireValue(
    object.concurrency === 1,
    "Paired lane requires concurrency one; delegation load is a separate experiment",
  );
  requireValue(
    typeof object.temperature === "number" &&
      Number.isFinite(object.temperature) &&
      object.temperature >= 0 &&
      object.temperature <= 2,
    "Invalid temperature",
  );
  requireValue(
    Number.isSafeInteger(object.seed) &&
      Number(object.seed) >= 0 &&
      Number(object.seed) <= 0xffffffff,
    "Invalid seed",
  );
  const global = validateLimits(object.global);
  const perTrial = validateLimits(object.perTrial);
  for (const key of limitKeys)
    requireValue(global[key] >= perTrial[key], `Global ${key} smaller than trial limit`);
  requireValue(
    perTrial.logicalInput >= Number(object.contextSize) &&
      perTrial.output >= Number(object.maxOutputTokens) &&
      perTrial.totalTokens >= Number(object.contextSize) + Number(object.maxOutputTokens),
    "Budget cannot reserve even one conservative request",
  );
  const resources = exactKeys(object.resources, [
    "memoryBytes",
    "cpuMs",
    "processes",
    "sampleMs",
    "diskBytes",
  ]);
  for (const [key, limit] of Object.entries(resources)) positiveInteger(limit, key);
  requireValue(Number(resources.sampleMs) <= 1000, "Resource sampling must be at most one second");
  const cohort = exactKeys(object.cohort, ["tasks", "repetitions", "history", "cacheState"]);
  requireValue(
    Array.isArray(cohort.tasks) &&
      cohort.tasks.length > 0 &&
      cohort.tasks.every((id) => typeof id === "string"),
    "Explicit cohort task list required",
  );
  requireValue(new Set(cohort.tasks).size === cohort.tasks.length, "Duplicate cohort task");
  for (const task of cohort.tasks) getTask(String(task));
  positiveInteger(cohort.repetitions, "repetitions");
  requireValue(
    Number(cohort.repetitions) <= 200 && ["short", "balanced"].includes(String(cohort.history)),
    "Invalid cohort",
  );
  requireValue(
    typeof cohort.cacheState === "string" && /^[a-z0-9-]{1,120}$/.test(cohort.cacheState),
    "Explicit cache stratum required",
  );
  const currency = exactKeys(object.currency, ["code", "cap", "priceSchedule"]);
  requireValue(
    typeof currency.code === "string" && /^[A-Z]{3}$/.test(currency.code),
    "Currency code required",
  );
  requireValue(
    typeof currency.cap === "number" &&
      Number.isFinite(currency.cap) &&
      currency.cap >= 0 &&
      currency.cap <= 1_000_000,
    "Invalid currency cap",
  );
  if (endpoint.paid) {
    requireValue(currency.cap > 0, "Paid endpoint needs positive currency cap");
    const price = exactKeys(currency.priceSchedule, [
      "version",
      "date",
      "source",
      "modelDigest",
      "inputPerMillion",
      "outputPerMillion",
    ]);
    requireValue(
      typeof price.version === "string" &&
        price.version.length > 0 &&
        typeof price.date === "string" &&
        /^\d{4}-\d\d-\d\d$/.test(price.date),
      "Versioned dated pricing required",
    );
    requireValue(
      typeof price.source === "string" &&
        new URL(price.source).protocol === "https:" &&
        price.modelDigest === model.digest,
      "Pricing must name the exact model and source",
    );
    for (const field of ["inputPerMillion", "outputPerMillion"])
      requireValue(
        typeof price[field] === "number" &&
          Number.isFinite(price[field]) &&
          Number(price[field]) > 0,
        "Unknown paid pricing",
      );
  } else
    requireValue(
      currency.cap === 0 && currency.priceSchedule === null,
      "Local API spend cap must be zero; energy and time are separate",
    );
  return JSON.parse(JSON.stringify(object)) as Budget;
}

/** Deliberately invalid until the owner supplies model identity; no automatic authorization. */
export function budgetTemplate() {
  const perTrial: Limits = {
    requests: 12,
    logicalInput: 120000,
    output: 12000,
    totalTokens: 132000,
    wallMs: 600000,
    toolCalls: 30,
    descendants: 4,
  };
  return {
    version: 1,
    endpoint: { origin: "http://127.0.0.1:11434", protocol: "ollama-openai", paid: false },
    model: {
      id: "qwen3:8b",
      digest: "OWNER_REQUIRED",
      quantization: "OWNER_REQUIRED",
      serverVersion: "OWNER_REQUIRED",
      tokenizerHash: "OWNER_REQUIRED",
      templateHash: "OWNER_REQUIRED",
    },
    contextSize: 16384,
    maxOutputTokens: 2048,
    temperature: 0,
    seed: 20260924,
    concurrency: 1,
    global: Object.fromEntries(Object.entries(perTrial).map(([key, limit]) => [key, limit * 4])),
    perTrial,
    resources: {
      memoryBytes: 2147483648,
      cpuMs: 600000,
      processes: 32,
      sampleMs: 100,
      diskBytes: 536870912,
    },
    cohort: {
      tasks: ["task-01", "task-04"],
      repetitions: 1,
      history: "short",
      cacheState: "cold-process-shared-server-cache-uncontrolled",
    },
    currency: { code: "USD", cap: 0, priceSchedule: null },
  };
}

export type Purpose = "main" | "retry" | "helper" | "summary" | "delegated" | "detached-learning";
export interface Reservation {
  id: string;
  trialId: string;
  purpose: Purpose | null;
  input: number;
  output: number;
  settled: boolean;
  uncertain: boolean;
  currency: number;
}
type Counters = Omit<Limits, "wallMs"> & { currency: number };
const counters = (): Counters => ({
  requests: 0,
  logicalInput: 0,
  output: 0,
  totalTokens: 0,
  toolCalls: 0,
  descendants: 0,
  currency: 0,
});

/** Synchronous reservation is the admission lock, including simultaneous async callers. */
export class BudgetLedger {
  readonly budget: Budget;
  readonly reservations: Reservation[] = [];
  private readonly global = counters();
  private readonly trials = new Map<
    string,
    { counters: Counters; start: number; closed: boolean }
  >();
  private readonly start: number;
  private inFlight = 0;
  private poisoned = false;
  constructor(
    budget: Budget,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.budget = immutable(parseBudget(budget));
    this.start = now();
  }
  open(trialId: string) {
    requireValue(!this.trials.has(trialId), "Trial already registered");
    this.trials.set(trialId, { counters: counters(), start: this.now(), closed: false });
  }
  close(trialId: string) {
    const trial = this.trials.get(trialId);
    if (trial) trial.closed = true;
  }
  private active(trialId: string) {
    const trial = this.trials.get(trialId);
    requireValue(trial && !trial.closed && !this.poisoned, "Budget trial closed");
    requireValue(
      this.now() - this.start < this.budget.global.wallMs &&
        this.now() - trial.start < this.budget.perTrial.wallMs,
      "budget-exhausted: wall time",
    );
    return trial;
  }
  remainingMs(trialId: string) {
    const trial = this.active(trialId);
    return Math.max(
      1,
      Math.min(
        this.budget.global.wallMs - (this.now() - this.start),
        this.budget.perTrial.wallMs - (this.now() - trial.start),
      ),
    );
  }
  reserve(trialId: string, purpose: Purpose | null): Reservation {
    const trial = this.active(trialId);
    requireValue(this.inFlight < this.budget.concurrency, "budget-exhausted: concurrency");
    const input = this.budget.contextSize;
    const output = this.budget.maxOutputTokens;
    const price = this.budget.currency.priceSchedule;
    const currency = price
      ? (input * price.inputPerMillion + output * price.outputPerMillion) / 1e6
      : 0;
    const additions = { requests: 1, logicalInput: input, output, totalTokens: input + output };
    for (const [key, value] of Object.entries(additions) as [keyof typeof additions, number][]) {
      requireValue(
        this.global[key] + value <= this.budget.global[key] &&
          trial.counters[key] + value <= this.budget.perTrial[key],
        `budget-exhausted: ${key}`,
      );
    }
    requireValue(
      Number.isFinite(currency) && this.global.currency + currency <= this.budget.currency.cap,
      "budget-exhausted: currency",
    );
    for (const [key, value] of Object.entries(additions) as [keyof typeof additions, number][]) {
      this.global[key] += value;
      trial.counters[key] += value;
    }
    this.global.currency += currency;
    trial.counters.currency += currency;
    this.inFlight++;
    const reservation: Reservation = {
      id: `request-${this.reservations.length + 1}`,
      trialId,
      purpose,
      input,
      output,
      settled: false,
      uncertain: true,
      currency,
    };
    this.reservations.push(reservation);
    return reservation;
  }
  settle(
    reservation: Reservation,
    usage: { logicalInput: number | null; output: number | null } | null,
  ) {
    requireValue(
      this.reservations.includes(reservation) && !reservation.settled,
      "Unknown or duplicate settlement",
    );
    reservation.settled = true;
    this.inFlight--;
    if (!usage || usage.logicalInput === null || usage.output === null) return;
    requireValue(
      [usage.logicalInput, usage.output].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      ),
      "Invalid authoritative usage",
    );
    if (usage.logicalInput > reservation.input || usage.output > reservation.output) {
      this.poisoned = true;
      throw new Error("Authoritative usage exceeded reservation; endpoint qualification invalid");
    }
    const trial = this.trials.get(reservation.trialId)!;
    for (const [key, refund] of [
      ["logicalInput", reservation.input - usage.logicalInput],
      ["output", reservation.output - usage.output],
      ["totalTokens", reservation.input + reservation.output - usage.logicalInput - usage.output],
    ] as const) {
      this.global[key] -= refund;
      trial.counters[key] -= refund;
    }
    // Currency is retained conservatively: cache and reasoning billing may differ.
    reservation.uncertain = false;
  }
  charge(trialId: string, kind: "toolCalls" | "descendants") {
    const trial = this.active(trialId);
    requireValue(
      this.global[kind] < this.budget.global[kind] &&
        trial.counters[kind] < this.budget.perTrial[kind],
      `budget-exhausted: ${kind}`,
    );
    this.global[kind]++;
    trial.counters[kind]++;
  }
  snapshot() {
    return {
      budgetHash: contentDigest(this.budget),
      global: { ...this.global },
      trials: [...this.trials].map(([id, trial]) => ({
        id,
        ...trial.counters,
        closed: trial.closed,
      })),
      inFlight: this.inFlight,
      poisoned: this.poisoned,
      reservations: structuredClone(this.reservations),
    };
  }
}
