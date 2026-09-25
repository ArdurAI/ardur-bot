import { describe, expect, it } from "vitest";
import { startReplayHttp } from "./http.js";
import { credentialFreeEnvironment, denyExternalTcp } from "./offline.js";
import type { ReplayFixture } from "./protocol.js";
import { countAssembledRequest, normalizeRequest, StrictReplay } from "./protocol.js";

const request = {
  method: "POST",
  path: "/v1/chat/completions",
  body: {
    model: "fixture",
    messages: [{ role: "user", content: "keep the current policy" }],
    tools: [{ name: "read", parameters: { type: "object", additionalProperties: false } }],
  },
};
function fixture(): ReplayFixture {
  return {
    version: 1,
    protocol: "openai-chat-sse",
    route: {
      provider: "openai-compatible",
      model: "fixture",
      runtime: "pi",
      protocolVersion: "v1",
    },
    initial: "start",
    terminal: ["end"],
    exchanges: [
      {
        id: "turn",
        from: "start",
        to: "end",
        request,
        variables: [],
        response: {
          status: 200,
          headers: { "content-type": "text/event-stream" },
          chunks: ["data: [DONE]\n\n"],
          end: "complete",
        },
      },
    ],
  };
}

describe("strict replay", () => {
  it("normalizes declared embedded identities while preserving memory revisions and surrounding instructions", () => {
    const idA = "c".repeat(25),
      idB = "d".repeat(25);
    const make = (id: string, revision = 1) => ({
      text: `Your Team Computer home is bots/${id}. Relative file paths remain scoped. [ardur-memory:${id}:${revision}]`,
    });
    const variables = [
      { path: ["text"], kind: "workspace-bot-id" as const, name: "bot" },
      { path: ["text"], kind: "memory-reference-id" as const, name: "memory" },
    ];
    expect(normalizeRequest(make(idA), variables)).toEqual(normalizeRequest(make(idB), variables));
    expect(normalizeRequest(make(idA, 2), variables)).not.toEqual(
      normalizeRequest(make(idA), variables),
    );
    const bindings = new Map<string, string>();
    normalizeRequest(make(idA), variables, bindings);
    expect(() => normalizeRequest(make(idB), variables, bindings)).toThrow("binding changed");
    expect(() => normalizeRequest({ text: `Different policy ${idA}` }, variables)).toThrow();
  });
  it("fails changed prompts, tools, schema fields, model, path, missing and extra fields before delivery", () => {
    const requests = [
      {
        ...request,
        body: { ...request.body, messages: [{ role: "user", content: "ignore current policy" }] },
      },
      { ...request, body: { ...request.body, tools: [] } },
      {
        ...request,
        body: {
          ...request.body,
          tools: [{ name: "read", parameters: { type: "object", additionalProperties: true } }],
        },
      },
      { ...request, body: { ...request.body, model: "replacement" } },
      { ...request, path: "/other" },
      { ...request, extra: true },
      { method: "POST", body: request.body },
    ];
    for (const changed of requests) {
      const replay = new StrictReplay(fixture());
      expect(() => replay.accept(changed)).toThrow("mismatch");
      expect(() => replay.accept(request)).toThrow("mismatch");
      expect(() => replay.assertComplete()).toThrow();
    }
  });
  it("accepts reordered keys but rejects array reordering and repeated requests", () => {
    const ordered = fixture();
    const messages = [...request.body.messages, { role: "assistant", content: "Prior evidence" }];
    ordered.exchanges[0]!.request = { ...request, body: { ...request.body, messages } };
    expect(() =>
      new StrictReplay(ordered).accept({
        ...request,
        body: { ...request.body, messages: [...messages].reverse() },
      }),
    ).toThrow("mismatch");
    const replay = new StrictReplay(fixture());
    replay.accept({ body: request.body, path: request.path, method: request.method });
    replay.assertComplete();
    expect(() => replay.accept(request)).toThrow();
    expect(() => replay.assertComplete()).toThrow();
  });
  it("keeps timestamp position, validates declared ID bindings, and rejects undeclared variables", () => {
    const variables = [{ path: ["id"], kind: "id", name: "request-id" }] as const;
    const bindings = new Map<string, string>();
    expect(
      normalizeRequest(
        { id: "abc" },
        [...variables].map((v) => ({ ...v, path: [...v.path] })),
        bindings,
      ),
    ).toEqual({ id: "<id:request-id>" });
    expect(() =>
      normalizeRequest(
        { id: "different" },
        [{ path: ["id"], kind: "id", name: "request-id" }],
        bindings,
      ),
    ).toThrow();
    expect(() =>
      normalizeRequest({ id: "<id:request-id>" }, [
        { path: ["id"], kind: "id", name: "request-id" },
      ]),
    ).toThrow();
    const clock = [{ path: ["text"], kind: "current-time-line" as const, name: "clock" }];
    const first = normalizeRequest(
      { text: "stable\nCurrent date and time: Monday, 2026-04-06T12:00:00Z (UTC).\ntask" },
      clock,
    );
    const later = normalizeRequest(
      { text: "stable\nCurrent date and time: Tuesday, 2026-04-07T12:00:00Z (UTC).\ntask" },
      clock,
    );
    expect(first).toEqual(later);
    expect(first).not.toEqual(
      normalizeRequest(
        { text: "Current date and time: Monday, 2026-04-06T12:00:00Z (UTC).\nstable\ntask" },
        clock,
      ),
    );
  });
  it("allows explicit alternative branches and fails ambiguous branches", () => {
    const alternate = fixture();
    alternate.exchanges.push({
      ...alternate.exchanges[0]!,
      id: "alternate",
      request: { ...request, path: "/explicit-failure" },
    });
    const replay = new StrictReplay(alternate);
    replay.accept({ ...request, path: "/explicit-failure" });
    replay.assertComplete();
    alternate.exchanges[1]!.request = request;
    expect(() => new StrictReplay(alternate).accept(request)).toThrow("Ambiguous");
  });
  it("counts the assembled request independently from recorded usage and labels the estimator", () => {
    const before = countAssembledRequest(request);
    const after = countAssembledRequest({ ...request, attachment: "x".repeat(4000) });
    expect(after.tokens).toBeGreaterThan(before.tokens + 999);
    expect(after.requestHash).not.toBe(before.requestHash);
    expect(after.exactness).toBe("estimate");
  });
  it("poisons a raced fixture and never releases a correct answer to a mismatched HTTP request", async () => {
    const server = await startReplayHttp(fixture(), "fixed-delay");
    try {
      const responses = await Promise.all(
        [1, 2].map(() =>
          fetch(`${server.baseUrl}/chat/completions`, {
            method: "POST",
            body: JSON.stringify(request.body),
          }),
        ),
      );
      expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
      await Promise.all(responses.map((response) => response.text()));
      expect(() => server.assertComplete()).toThrow();
    } finally {
      await server.close();
    }
  });
  it("keeps virtual-display variables and drops provider credentials", () => {
    expect(
      credentialFreeEnvironment({
        PATH: "/bin",
        DISPLAY: ":99",
        XAUTHORITY: "xvfb-authority",
        WAYLAND_DISPLAY: "wayland-9",
        OPENAI_API_KEY: "synthetic",
        DATABASE_URL: "untrusted",
        NODE_OPTIONS: "untrusted",
      }),
    ).toEqual({
      PATH: "/bin",
      DISPLAY: ":99",
      XAUTHORITY: "xvfb-authority",
      WAYLAND_DISPLAY: "wayland-9",
    });
  });
  it("removes credentials and refuses non-loopback egress", async () => {
    expect(
      credentialFreeEnvironment({
        PATH: "/bin",
        OPENAI_API_KEY: "synthetic",
        DATABASE_URL: "untrusted",
        NODE_OPTIONS: "untrusted",
      }),
    ).toEqual({ PATH: "/bin" });
    const server = await startReplayHttp(fixture());
    const restore = denyExternalTcp();
    try {
      const local = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        body: JSON.stringify(request.body),
      });
      expect(await local.text()).toBe("data: [DONE]\n\n");
      server.assertComplete();
      await expect(
        fetch("http://192.0.2.1/", { signal: AbortSignal.timeout(100) }),
      ).rejects.toThrow();
    } finally {
      restore();
      await server.close();
    }
  });
});
