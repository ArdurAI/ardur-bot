import { ModelConnectInputSchema, ollamaThink } from "@ardurbot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildModelConnectPlaintext, modelCredentialDto } from "./model-connect.js";
import { modelAcceptsImageInput } from "./model-vision.js";
import {
  discoverOllama,
  normalizeOllamaUrl,
  ollamaCatalog,
  pullOllamaModel,
  showOllamaModel,
} from "./ollama.js";

const baseUrl = "http://127.0.0.1:11434";
function fakeOllama(capabilities: string[] = ["completion", "thinking", "vision"]) {
  return vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/tags")
      return Response.json({ models: [{ name: "qwen3:8b", details: { parameter_size: "8.2B" } }] });
    if (path === "/api/version") return Response.json({ version: "test-version" });
    if (path === "/api/show") {
      expect(JSON.parse(String(init?.body))).toEqual({ model: "qwen3:8b" });
      return Response.json({ capabilities, model_info: { "qwen3.context_length": 40960 } });
    }
    throw new Error(`Unexpected test request: ${path}`);
  });
}
afterEach(() => vi.unstubAllEnvs());

describe("Ollama discovery", () => {
  it("discovers installed models, capabilities, context and version without environment configuration", async () => {
    vi.stubEnv("ARDURBOT_LOCAL_MODELS", "");
    vi.stubEnv("ARDURBOT_LOCAL_CONTEXT_WINDOW", "123");
    const fetch = fakeOllama();
    const result = await discoverOllama(baseUrl, undefined, fetch);
    expect(result).toEqual({
      version: "test-version",
      models: [
        {
          id: "qwen3:8b",
          parameterSize: "8.2B",
          reasoning: true,
          acceptsImages: true,
          supportsThinkingOff: true,
          contextWindow: 40960,
        },
      ],
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(ollamaCatalog(result.models, "connection")[0]).toMatchObject({
      provider: "ollama",
      label: "qwen3:8b · 8.2B",
      credentialId: "connection",
    });
  });
  it("gates absent capabilities and never uses the legacy context fallback", async () => {
    vi.stubEnv("ARDURBOT_LOCAL_CONTEXT_WINDOW", "123");
    const model = await showOllamaModel(
      baseUrl,
      "model",
      undefined,
      vi.fn(async () => Response.json({})),
    );
    expect(model).toEqual({
      id: "model",
      reasoning: false,
      acceptsImages: false,
      supportsThinkingOff: true,
    });
    expect(ollamaThink(null, model)).toBeUndefined();
    expect(() => ollamaThink("low", model)).toThrow("not applicable");
    expect(modelAcceptsImageInput("ollama", "model", model.acceptsImages)).toBe(false);
    expect(modelAcceptsImageInput("ollama", "model", true)).toBe(true);
  });
  it("does not advertise off for a model that only reports named levels", async () => {
    const model = await showOllamaModel(
      baseUrl,
      "model",
      undefined,
      vi.fn(async () =>
        Response.json({
          capabilities: ["thinking"],
          thinking: { values: ["low", "medium", "high"] },
        }),
      ),
    );
    expect(() => ollamaThink("none", model)).toThrow("does not support");
    expect(ollamaCatalog([model], "connection")[0]?.thinkingLevels).not.toContain("off");
  });
  it("preserves an empty installed list", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      Response.json(
        String(url).endsWith("/version") ? { version: "test-version" } : { models: [] },
      ),
    );
    expect(await discoverOllama(baseUrl, undefined, fetch)).toEqual({
      version: "test-version",
      models: [],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("reports connection refused in plain copy", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    });
    await expect(discoverOllama(baseUrl, undefined, fetch)).rejects.toThrow(
      "Ollama is not running. Start it and try again.",
    );
  });
  it("rejects malformed lists and unsafe URLs", async () => {
    await expect(
      discoverOllama(
        baseUrl,
        undefined,
        vi.fn(async () => Response.json({ models: "bad", version: "test" })),
      ),
    ).rejects.toThrow();
    expect(() => normalizeOllamaUrl("http://169.254.169.254")).toThrow();
    expect(() => normalizeOllamaUrl("http://user:password@localhost")).toThrow();
    expect(normalizeOllamaUrl(`${baseUrl}/v1/`)).toBe(baseUrl);
  });
  it("saves only the keyless connection and exposes it as connected", () => {
    const input = ModelConnectInputSchema.parse({ provider: "ollama", baseUrl });
    const plaintext = buildModelConnectPlaintext(input);
    expect(JSON.parse(plaintext)).toEqual({ kind: "openai_compatible", baseUrl });
    expect(
      modelCredentialDto(
        { id: "connection", provider: "ollama", label: "Ollama", isDefault: true },
        plaintext,
      ),
    ).toMatchObject({ hasKey: true, baseUrl });
  });
});

describe("Ollama pull stream", () => {
  it("decodes chunk boundaries, optional counters and the final success", async () => {
    const text =
      '{"status":"pulling manifest"}\n{"status":"pulling layer","digest":"sha256:test","completed":5,"total":10}\n{"status":"success"}';
    const encoder = new TextEncoder();
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ model: "qwen3:0.6b", stream: true });
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const piece of [text.slice(0, 7), text.slice(7, 45), text.slice(45)])
              controller.enqueue(encoder.encode(piece));
            controller.close();
          },
        }),
      );
    });
    const events = [];
    for await (const event of pullOllamaModel(baseUrl, "qwen3:0.6b", undefined, fetch))
      events.push(event);
    expect(events).toEqual([
      { status: "pulling manifest" },
      { status: "pulling layer", digest: "sha256:test", completed: 5, total: 10 },
      { status: "success" },
    ]);
  });
  it("cancels an idle reader and forwards the caller's abort signal", async () => {
    const controller = new AbortController();
    const cancelled = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      return new Response(new ReadableStream({ cancel: cancelled }));
    });
    const iterator = pullOllamaModel(baseUrl, "model", controller.signal, fetch);
    const next = iterator.next();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort();
    await expect(next).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toHaveBeenCalledOnce();
  });
  it.each(['{"status":"pulling manifest"}\n', '{"error":"private upstream details"}\n'])(
    "rejects interrupted or failed streams",
    async (body) => {
      await expect(
        (async () => {
          for await (const _ of pullOllamaModel(
            baseUrl,
            "model",
            undefined,
            vi.fn(async () => new Response(body)),
          )) {
            /* Drain. */
          }
        })(),
      ).rejects.toThrow(/Try again|try again/);
    },
  );
});
