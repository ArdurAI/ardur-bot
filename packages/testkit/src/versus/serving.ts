import type { Budget } from "./budget.js";
import { record, requireValue } from "./budget.js";
import { sanitize } from "./provenance.js";

export interface RouteExpectation {
  origin: string;
  model: string;
  digest: string;
  quantization: string;
  contextSize: number;
}

/** Bounded Ollama metadata read. Redirects fail; nothing is generated, pulled, loaded or kept alive. */
export async function readMetadata(
  transport: typeof fetch,
  origin: string,
  route: string,
  body?: unknown,
) {
  const response = await transport(`${origin}${route}`, {
    method: body ? "POST" : "GET",
    redirect: "error",
    signal: AbortSignal.timeout(5000),
    headers: body ? { "content-type": "application/json" } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  requireValue(response.ok, `Metadata unavailable: ${route} (${response.status})`);
  requireValue(response.body, "Metadata response missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      requireValue(size <= 16 * 1024 * 1024, "Metadata exceeds byte cap");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  return record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

/** Read-only Ollama serving-state attestation. It never loads or extends a model lease. */
export function parseServingContext(value: unknown, expected: RouteExpectation): number {
  const state = record(value);
  requireValue(Array.isArray(state.models), "Missing serving model inventory");
  const matches = state.models
    .map(record)
    .filter((item) => item.name === expected.model && item.digest === expected.digest);
  requireValue(matches.length === 1, "Expected model is not uniquely loaded");
  const context = matches[0]!.context_length;
  requireValue(
    typeof context === "number" && Number.isSafeInteger(context) && context > 0,
    "Loaded model context is unavailable",
  );
  return context;
}

export interface ServingObservation {
  stage: "trial-admission" | "model-request";
  trialId: string;
  declaredContext: number;
  observedContext: number | null;
  admitted: boolean;
  reason: string | null;
}

/** Re-reads `/api/ps` before each admission; a planning-time observation is never a lease. */
export class ServingWitness {
  readonly observations: ServingObservation[] = [];
  private readonly route: RouteExpectation;
  constructor(
    budget: Budget,
    private readonly transport: typeof fetch = fetch,
  ) {
    requireValue(!budget.endpoint.paid, "Serving attestation reads local Ollama state only");
    this.route = {
      origin: budget.endpoint.origin,
      model: budget.model.id,
      digest: budget.model.digest,
      quantization: budget.model.quantization,
      contextSize: budget.contextSize,
    };
  }
  /** Origin, model, digest and context copied from the budget this witness was built to attest. */
  identity(): { origin: string; model: string; digest: string; contextSize: number } {
    return {
      origin: this.route.origin,
      model: this.route.model,
      digest: this.route.digest,
      contextSize: this.route.contextSize,
    };
  }
  async attest(stage: ServingObservation["stage"], trialId: string) {
    const observation: ServingObservation = {
      stage,
      trialId,
      declaredContext: this.route.contextSize,
      observedContext: null,
      admitted: false,
      reason: null,
    };
    this.observations.push(observation);
    try {
      observation.observedContext = parseServingContext(
        await readMetadata(this.transport, this.route.origin, "/api/ps"),
        this.route,
      );
      requireValue(
        observation.observedContext === this.route.contextSize,
        `Loaded serving context ${observation.observedContext} does not match declared context ${this.route.contextSize}`,
      );
      observation.admitted = true;
    } catch (error) {
      observation.reason = sanitize(error instanceof Error ? error.message : String(error));
      throw new Error(`Serving state refused ${stage}: ${observation.reason}`);
    }
  }
}
