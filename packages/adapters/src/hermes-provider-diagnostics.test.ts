import { afterEach, expect, it, vi } from "vitest";
import { diagnosticProviderFetch, upstreamHttpFailure } from "./hermes-provider-diagnostics.js";

const PRIVATE = "private fixture response text";
afterEach(() => vi.useRealTimers());

it.each([400, 401, 403, 429])(
  "reads bounded reason codes for a refusal status %s",
  async (status) => {
    const response = new Response(JSON.stringify({ error: { code: "1305", message: PRIVATE } }), {
      status,
      headers: { "content-type": "application/json" },
    });
    const observe = vi.fn();
    const result = await diagnosticProviderFetch(
      async () => response,
      observe,
    )("https://fixture.invalid");
    expect(result).toBe(response);
    expect(observe).toHaveBeenLastCalledWith({
      ...upstreamHttpFailure(status),
      reasonCode: "1305",
    });
    expect(await result.json()).toEqual({ error: { code: "1305", message: PRIVATE } });
  },
);

it.each([404, 408, 422, 500, 502, 503, 504])(
  "returns status %s without reading a stalled error body or starting a deadline",
  async (status) => {
    vi.useFakeTimers();
    const response = new Response(new ReadableStream({ start() {} }), {
      status,
      headers: { "content-type": "application/json" },
    });
    const clone = vi.spyOn(response, "clone");
    const observe = vi.fn();
    const pending = diagnosticProviderFetch(
      async () => response,
      observe,
    )("https://fixture.invalid");
    await vi.advanceTimersByTimeAsync(0);
    const timers = vi.getTimerCount();
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    void response.body?.cancel();
    expect(result).toBe(response);
    expect(clone).not.toHaveBeenCalled();
    expect(timers).toBe(0);
    expect(observe).toHaveBeenLastCalledWith(upstreamHttpFailure(status));
  },
);

it.each(["1305", 1305, "rate_limit_exceeded", "insufficient_quota"])(
  "retains only the known upstream reason code %s without consuming the adapter response",
  async (code) => {
    const response = new Response(JSON.stringify({ error: { code, message: PRIVATE } }), {
      status: 429,
      headers: { "content-type": "application/json" },
    });
    const observe = vi.fn();
    const result = await diagnosticProviderFetch(
      async () => response,
      observe,
    )("https://fixture.invalid");
    expect(observe).toHaveBeenLastCalledWith({
      kind: "provider-http",
      status: 429,
      layer: "upstream",
      reason: "http-rate-limit",
      reasonCode: String(code),
    });
    expect(JSON.stringify(observe.mock.calls)).not.toContain(PRIVATE);
    expect(await result.json()).toEqual({ error: { code, message: PRIVATE } });
  },
);

it.each([
  [{ error: { code: PRIVATE } }, "application/json"],
  [{ error: { code: { secret: PRIVATE } } }, "application/json"],
  [{ error: { code: "1305", message: "x".repeat(4096) } }, "application/json"],
  ["not JSON", "application/json"],
  ["1305", "text/html"],
])("drops unknown, oversized and non-JSON diagnostics: %j", async (body, contentType) => {
  const response = new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 429,
    headers: { "content-type": contentType },
  });
  const observe = vi.fn();
  await diagnosticProviderFetch(async () => response, observe)("https://fixture.invalid");
  expect(observe).toHaveBeenLastCalledWith({
    kind: "provider-http",
    status: 429,
    layer: "upstream",
    reason: "http-rate-limit",
  });
});

it("does not wait indefinitely for an error body", async () => {
  vi.useFakeTimers();
  const response = new Response(new ReadableStream({ start() {} }), {
    status: 429,
    headers: { "content-type": "application/json" },
  });
  const observe = vi.fn();
  const pending = diagnosticProviderFetch(async () => response, observe)("https://fixture.invalid");
  await vi.advanceTimersByTimeAsync(1000);
  expect(await pending).toBe(response);
  expect(observe).toHaveBeenLastCalledWith({
    kind: "provider-http",
    status: 429,
    layer: "upstream",
    reason: "http-rate-limit",
  });
  void response.body?.cancel();
});
