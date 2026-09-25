import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { UsageCategories } from "@ardurbot/adapter-kit";
import { contentDigest } from "../scoreboard/manifest.js";
import type { Emit } from "./adapters/types.js";
import type { Budget, Purpose, Reservation } from "./budget.js";
import { type BudgetLedger, record, requireValue } from "./budget.js";
import { sanitize } from "./provenance.js";
import type { ServingWitness } from "./serving.js";

const categoryNames = [
  "logicalInput",
  "uncachedInput",
  "cacheReadInput",
  "cacheWriteInput",
  "output",
  "reasoning",
] as const;
export function emptyUsage(): UsageCategories {
  return {
    logicalInput: null,
    uncachedInput: null,
    cacheReadInput: null,
    cacheWriteInput: null,
    output: null,
    reasoning: null,
  };
}
function token(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  requireValue(
    Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 2_147_483_647,
    "Invalid provider usage",
  );
  return Number(value);
}
export function openAiUsage(value: unknown): UsageCategories {
  if (value === undefined || value === null) return emptyUsage();
  const usage = record(value);
  const input = token(usage.prompt_tokens);
  const output = token(usage.completion_tokens);
  const details = usage.prompt_tokens_details ? record(usage.prompt_tokens_details) : {};
  const outputDetails = usage.completion_tokens_details
    ? record(usage.completion_tokens_details)
    : {};
  const read = token(details.cached_tokens);
  const write = token(details.cache_creation_tokens);
  const reasoning = token(outputDetails.reasoning_tokens);
  requireValue(
    input === null || (read ?? 0) + (write ?? 0) <= input,
    "Cache categories exceed logical input",
  );
  requireValue(
    output === null || reasoning === null || reasoning <= output,
    "Reasoning exceeds output",
  );
  // Missing cache-write information does not establish that it was zero.
  return {
    logicalInput: input,
    uncachedInput: input !== null && read !== null && write !== null ? input - read - write : null,
    cacheReadInput: read,
    cacheWriteInput: write,
    output,
    reasoning,
  };
}

/** Epoch and sequence are observations supplied by the collector, never guessed from a decrease. */
export class UsageCounter {
  private epochs = new Map<string, { sequence: number; categories: UsageCategories }>();
  delta(epoch: string, sequence: number, current: UsageCategories): UsageCategories {
    requireValue(
      /^[a-zA-Z0-9-]{1,120}$/.test(epoch) && Number.isSafeInteger(sequence) && sequence >= 0,
      "Invalid counter identity",
    );
    const previous = this.epochs.get(epoch);
    requireValue(
      previous ? sequence === previous.sequence + 1 : sequence === 0,
      "Counter sequence missing or repeated",
    );
    const delta = emptyUsage();
    for (const key of categoryNames) {
      const value = token(current[key]);
      const prior = previous?.categories[key];
      requireValue(
        value === null || prior == null || value >= prior,
        "Counter decreased without a new epoch",
      );
      delta[key] = value === null || (previous && prior === null) ? null : value - (prior ?? 0);
    }
    this.epochs.set(epoch, { sequence, categories: { ...current } });
    return delta;
  }
}

function assertServingWitness(budget: Budget, serving: ServingWitness | undefined) {
  if (!serving) return;
  const identity = serving.identity();
  if (
    identity.model === budget.model.id &&
    identity.digest === budget.model.digest &&
    identity.contextSize === budget.contextSize
  )
    return;
  const error = new Error(
    "Serving witness model, digest, or context does not match the gateway budget",
  ) as Error & { code: string };
  error.code = "serving-witness-mismatch";
  throw error;
}

export async function readJson(request: IncomingMessage, maxBytes = 1024 * 1024) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += Buffer.byteLength(chunk);
    requireValue(bytes <= maxBytes, "Request exceeds byte budget");
    chunks.push(Buffer.from(chunk));
  }
  return record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

export interface GatewayRequest {
  id: string;
  trialId: string;
  purpose: Purpose | null;
  requestHash: string;
  outcome: "success" | "failed" | "cancelled";
  usage: UsageCategories;
  missingReason: string | null;
  authoritative: boolean;
}
interface Capability {
  trialId: string;
  purpose: Purpose | null;
  emit: Emit;
  controller: AbortController;
}

/** The sole inference egress boundary. Agents receive a revocable capability, never provider credentials. */
export async function startGateway(options: {
  budget: Budget;
  ledger: BudgetLedger;
  transport?: (url: string, init: RequestInit) => Promise<Response>;
  credential?: () => string | undefined;
  evidenceKind: "virtual" | "provider-live";
  /** Re-attests the loaded model and context before each trial admission and model request. */
  serving?: ServingWitness;
}) {
  const budget = options.ledger.budget;
  requireValue(
    contentDigest(options.budget) === contentDigest(budget),
    "Gateway and admission budget differ",
  );
  requireValue(
    options.evidenceKind === "virtual" || options.serving,
    "Live inference requires serving-state attestation at admission",
  );
  assertServingWitness(budget, options.serving);
  const capabilities = new Map<string, Capability>();
  const admitted = new Set<string>();
  const requests: GatewayRequest[] = [];
  const transport = options.transport ?? fetch;
  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      if (!response.headersSent) response.writeHead(403, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: sanitize(error instanceof Error ? error.message : "Gateway refused request"),
          },
        }),
      );
    });
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const route = /^\/c\/(cap_[a-f0-9]{48})\/v1\/(chat\/completions|models)$/.exec(
      request.url ?? "",
    );
    const cap = route ? capabilities.get(route[1]!) : undefined;
    requireValue(cap && !cap.controller.signal.aborted, "Unknown or revoked trial capability");
    assertServingWitness(budget, options.serving);
    options.ledger.remainingMs(cap.trialId);
    if (request.method === "GET" && route![2] === "models") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          object: "list",
          data: [{ id: budget.model.id, object: "model", owned_by: "declared-route" }],
        }),
      );
      return;
    }
    requireValue(
      request.method === "POST" && route![2] === "chat/completions",
      "Unsupported provider operation",
    );
    const body = await readJson(request);
    requireValue(body.model === budget.model.id, "Model route drift");
    requireValue(Array.isArray(body.messages) && body.messages.length > 0, "Messages required");
    requireValue(
      body.n === undefined || body.n === 1,
      "Multiple completions exceed admission contract",
    );
    requireValue(
      body.temperature === undefined || body.temperature === budget.temperature,
      "Temperature route drift",
    );
    requireValue(body.seed === undefined || body.seed === budget.seed, "Seed route drift");
    requireValue(
      body.stream === undefined || typeof body.stream === "boolean",
      "Invalid stream flag",
    );
    requireValue(
      !body.audio &&
        !body.modalities &&
        !body.file &&
        !body.image &&
        !JSON.stringify(body.messages).includes('"image_url"'),
      "Only text/tool qualification is supported",
    );
    // Bound the complete wire envelope as well as reserving the entire model context.
    // A too-large request is refused; bytes/4 is never an admission counter.
    requireValue(
      Buffer.byteLength(JSON.stringify(body)) <= budget.contextSize,
      "Request exceeds conservative byte envelope",
    );
    const forward: Record<string, unknown> = {
      ...body,
      n: 1,
      model: budget.model.id,
      max_tokens: budget.maxOutputTokens,
      temperature: budget.temperature,
      seed: budget.seed,
    };
    delete forward.max_completion_tokens;
    if (body.stream) forward.stream_options = { include_usage: true };
    await options.serving?.attest("model-request", cap.trialId);
    const remainingMs = options.ledger.remainingMs(cap.trialId);
    const reservation = options.ledger.reserve(cap.trialId, cap.purpose);
    const requestHash = contentDigest(forward);
    const observation: GatewayRequest = {
      id: reservation.id,
      trialId: cap.trialId,
      purpose: cap.purpose,
      requestHash,
      outcome: "failed",
      usage: emptyUsage(),
      missingReason: "failed-before-usage",
      authoritative: false,
    };
    requests.push(observation);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    cap.controller.signal.addEventListener("abort", cancel, { once: true });
    response.once("close", () => {
      if (!response.writableEnded) cancel();
    });
    const timer = setTimeout(cancel, remainingMs);
    cap.emit("provider-request", "provider-gateway", {
      requestId: reservation.id,
      requestHash,
      purpose: cap.purpose,
      reservation: { input: reservation.input, output: reservation.output },
      attribution: cap.purpose === null ? "runtime-purpose-unobserved" : "capability-bound",
    });
    try {
      const credential = options.credential?.();
      const upstream = await transport(`${budget.endpoint.origin}/v1/chat/completions`, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(credential ? { authorization: `Bearer ${credential}` } : {}),
        },
        body: JSON.stringify(forward),
      });
      requireValue(upstream.ok, `Provider failed (${upstream.status})`);
      response.writeHead(200, {
        "content-type": body.stream ? "text/event-stream" : "application/json",
      });
      let receivedUsage = false;
      const observe = (payload: unknown) => {
        const data = record(payload);
        requireValue(
          data.model === undefined || data.model === budget.model.id,
          "Provider returned a different model",
        );
        if (data.usage !== undefined && data.usage !== null) {
          requireValue(!receivedUsage, "Duplicate final usage is ambiguous");
          receivedUsage = true;
          observation.usage = openAiUsage(data.usage);
          observation.authoritative = true;
        }
        if (Array.isArray(data.choices))
          for (const choice of data.choices) {
            const object = record(choice);
            const delta = object.delta ?? object.message;
            if (delta && typeof delta === "object") {
              const text = (delta as Record<string, unknown>).content;
              if (typeof text === "string" && text.length)
                cap.emit("content", "provider-gateway", {
                  requestId: reservation.id,
                  text: sanitize(text),
                  evidenceKind: options.evidenceKind,
                });
            }
          }
      };
      if (!body.stream) {
        const text = await boundedText(upstream, 4 * 1024 * 1024);
        observe(JSON.parse(text));
        response.end(text);
      } else {
        requireValue(upstream.body, "Provider stream missing");
        const decoder = new TextDecoder();
        let pending = "";
        let bytes = 0;
        let done = false;
        for await (const chunk of upstream.body) {
          bytes += chunk.length;
          requireValue(bytes <= 4 * 1024 * 1024, "Provider output byte limit exceeded");
          pending += decoder.decode(chunk, { stream: true });
          let boundary = pending.indexOf("\n");
          while (boundary !== -1) {
            const line = pending.slice(0, boundary).replace(/\r$/, "");
            pending = pending.slice(boundary + 1);
            if (line.startsWith("data:")) {
              const data = line.slice(5).trim();
              if (data === "[DONE]") done = true;
              else if (data) {
                requireValue(!done, "Content after stream terminal");
                observe(JSON.parse(data));
              }
            }
            boundary = pending.indexOf("\n");
          }
          if (!response.write(chunk)) await once(response, "drain", { signal: controller.signal });
        }
        pending += decoder.decode();
        requireValue(done && !pending.trim(), "Malformed or incomplete provider stream");
        response.end();
      }
      observation.outcome = "success";
      observation.missingReason = receivedUsage ? null : "provider-omitted";
    } catch (error) {
      observation.outcome = controller.signal.aborted ? "cancelled" : "failed";
      observation.missingReason = controller.signal.aborted
        ? "cancelled-before-usage"
        : "failed-before-usage";
      // Partial usage on a failed transport is not proof of final billing.
      observation.authoritative = false;
      throw error;
    } finally {
      clearTimeout(timer);
      cap.controller.signal.removeEventListener("abort", cancel);
      try {
        settle(reservation, observation);
      } catch {
        observation.outcome = "failed";
        observation.authoritative = false;
        observation.missingReason = "invalid-trial";
        cap.controller.abort();
        cap.emit("diagnostic", "provider-gateway", {
          requestId: observation.id,
          reason: "reservation-overrun; further admission disabled",
        });
      } finally {
        cap.emit("usage", "provider-gateway", {
          ...observation,
          evidenceKind: options.evidenceKind,
        });
      }
    }
  }
  function settle(reservation: Reservation, observation: GatewayRequest) {
    options.ledger.settle(reservation, observation.authoritative ? observation.usage : null);
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    requests,
    /** Opens the trial's budget only while the serving state still matches the declared route. */
    async admit(trialId: string) {
      assertServingWitness(budget, options.serving);
      await options.serving?.attest("trial-admission", trialId);
      options.ledger.open(trialId);
      admitted.add(trialId);
    },
    capability(trialId: string, purpose: Purpose | null, emit: Emit) {
      requireValue(
        !options.serving || admitted.has(trialId),
        "Trial was not admitted against the serving state",
      );
      const token = `cap_${randomBytes(24).toString("hex")}`;
      capabilities.set(token, { trialId, purpose, emit, controller: new AbortController() });
      return `${origin}/c/${token}/v1`;
    },
    revoke(trialId: string) {
      for (const [token, cap] of capabilities)
        if (cap.trialId === trialId) {
          cap.controller.abort();
          capabilities.delete(token);
        }
      options.ledger.close(trialId);
    },
    async close() {
      for (const cap of capabilities.values()) cap.controller.abort();
      capabilities.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

async function boundedText(response: Response, max: number) {
  requireValue(response.body, "Missing response body");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    requireValue(bytes <= max, "Response exceeds byte limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Metadata is a preflight, never a tool-protocol or reasoning qualification. */
export async function verifyLocalModel(budget: Budget) {
  requireValue(!budget.endpoint.paid, "Paid lanes are not enabled in the initial local slice");
  const get = async (route: string) => {
    const response = await fetch(`${budget.endpoint.origin}${route}`, {
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    requireValue(response.ok, "Model metadata unavailable");
    return record(JSON.parse(await boundedText(response, 1024 * 1024)));
  };
  const version = await get("/api/version");
  requireValue(version.version === budget.model.serverVersion, "Server version drift");
  const tags = await get("/api/tags");
  requireValue(Array.isArray(tags.models), "Model inventory unavailable");
  const model = tags.models
    .map(record)
    .find((item) => item.name === budget.model.id || item.model === budget.model.id);
  requireValue(
    model &&
      model.digest === budget.model.digest &&
      record(model.details).quantization_level === budget.model.quantization,
    "Model digest or quantization drift",
  );
  return {
    modelDigest: model.digest,
    serverVersion: version.version,
    qualification: "metadata-only",
  };
}
