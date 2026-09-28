import { describe, expect, it } from "vitest";
import * as z from "zod";
import {
  decodeHostFrame,
  encodeHostFrame,
  HOST_FRAME_BYTES,
  HOST_HEALTH_ACCEPTED,
  HOST_WRITE_FRAME_BYTES,
  HostOperationSchema,
  HostRuntimeEventSchema,
  hostSocketUrl,
  negotiateHostHealth,
} from "./host-bridge.js";
import { RuntimeKindSchema } from "./runtime-pins.js";

describe("host protocol", () => {
  it("keeps a new host's health valid for strict servers before and after provider relay", () => {
    const health = {
      platform: "linux" as const,
      roots: [],
      load: 0,
      claude: { runtimeKind: "claude-code" as const, available: false, models: [] },
      codex: { runtimeKind: "codex-app-server" as const, available: false, models: [] },
      hermes: { runtimeKind: "hermes" as const, available: false, models: [] },
      capabilities: {
        providerRelay: 1 as const,
        hermesConfigurationProfile: "hermes-ardur-v2" as const,
        hermesLauncherGeneration: 1 as const,
      },
    };
    const preRelayHealth = z.strictObject({
      platform: z.literal("linux"),
      roots: z.array(z.string()),
      load: z.literal(0),
      claude: z.unknown(),
      codex: z.unknown(),
    });
    const relayHealth = preRelayHealth.extend({
      hermes: z.unknown().optional(),
      capabilities: z.strictObject({ providerRelay: z.literal(1) }).optional(),
    });
    const legacy = negotiateHostHealth(health, undefined);
    expect(preRelayHealth.parse(legacy)).toEqual(legacy);
    expect(legacy.capabilities).toBeUndefined();
    expect(legacy.hermes).toBeUndefined();
    const relay = negotiateHostHealth(health, "providerRelay,hermes");
    expect(relayHealth.parse(relay)).toEqual(relay);
    expect(relay.capabilities).toEqual({ providerRelay: 1 });
    expect(relay.hermes).toEqual(health.hermes);
    expect(relayHealth.safeParse(health).success).toBe(false);
  });
  it("accepts an old host and advertises the complete profile to a new one", () => {
    const oldHealth = {
      platform: "linux" as const,
      roots: [],
      load: 0,
      claude: { runtimeKind: "claude-code" as const, available: false, models: [] },
      codex: { runtimeKind: "codex-app-server" as const, available: false, models: [] },
    };
    expect(decodeHostFrame(JSON.stringify({ v: 1, type: "health", health: oldHealth }))).toEqual({
      v: 1,
      type: "health",
      health: oldHealth,
    });
    const newHealth = {
      ...oldHealth,
      hermes: { runtimeKind: "hermes" as const, available: true, models: [] },
      capabilities: {
        providerRelay: 1 as const,
        hermesConfigurationProfile: "hermes-ardur-v2" as const,
        hermesLauncherGeneration: 1 as const,
      },
    };
    expect(negotiateHostHealth(newHealth, HOST_HEALTH_ACCEPTED)).toEqual(newHealth);
    expect(decodeHostFrame(encodeHostFrame({ v: 1, type: "health", health: newHealth }))).toEqual({
      v: 1,
      type: "health",
      health: newHealth,
    });
  });
  it("round-trips a Hermes terminal problem with its product runtime kind", () => {
    const frame = {
      v: 1 as const,
      type: "end" as const,
      id: "hermes-run",
      problem: {
        kind: "problem" as const,
        code: "runtime-unavailable" as const,
        pin: {
          runtimeKind: "hermes" as const,
          provider: "fixture",
          modelId: "fixture-model",
          effort: "high",
          credentialId: "fixture-credential",
          revision: 1,
        },
        reason: "Pinned install is unavailable.",
        actions: ["change-pin" as const],
      },
    };
    expect(decodeHostFrame(encodeHostFrame(frame))).toEqual(frame);
    expect(RuntimeKindSchema.safeParse("hermes").success).toBe(true);
  });
  it("carries numeric usage receipts across the strict host boundary and rejects raw payloads", () => {
    const event = {
      type: "usage",
      provider: "fixture",
      model: "fixture",
      inputTokens: 0,
      outputTokens: 0,
      reported: false,
      request: {
        requestId: "request",
        attemptId: "attempt",
        parentRequestId: null,
        purpose: "main",
        counter: { mode: "cumulative", epochId: "0", sequence: 0 },
        inputSemantics: "unknown",
        reasoningSemantics: "unknown",
        categories: {
          logicalInput: null,
          uncachedInput: null,
          cacheReadInput: null,
          cacheWriteInput: null,
          output: null,
          reasoning: null,
        },
        cost: null,
        pricingProvenance: null,
        collection: {
          mappingVersion: "fixture-v1",
          scope: "native-turn",
          outcome: "started",
          availability: "unavailable",
          raw: {},
          limitations: ["native-request-detail-unavailable"],
        },
      },
    };
    expect(HostRuntimeEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
    expect(
      HostRuntimeEventSchema.safeParse({
        ...event,
        request: {
          ...event.request,
          collection: { ...event.request.collection, raw: { prompt: "must not persist" } },
        },
      }).success,
    ).toBe(false);
  });
  it("round-trips versioned streams and refuses oversize frames before parsing", () => {
    const frame = {
      v: 1 as const,
      type: "stream" as const,
      id: "request",
      seq: 0,
      channel: "stdout" as const,
      data: "hello",
    };
    expect(decodeHostFrame(encodeHostFrame(frame))).toEqual(frame);
    expect(() => decodeHostFrame("x".repeat(HOST_WRITE_FRAME_BYTES + 1))).toThrow("too large");
    expect(() => encodeHostFrame({ ...frame, data: "é".repeat(HOST_FRAME_BYTES) })).toThrow(
      "too large",
    );
    expect(() => decodeHostFrame(JSON.stringify({ ...frame, v: 2 }))).toThrow();
  });
  it.each([
    { op: "shell", command: "echo test" },
    { op: "computer.exec", homeKey: "bot", argv: ["echo"], env: { KEY: "not-forwarded" } },
    { op: "computer.exec", homeKey: "bot", argv: ["echo"], binary: "/bin/echo" },
    { op: "computer.exec", homeKey: "bot", argv: ["echo"], cwd: "work/../other" },
  ])("refuses an unapproved request %j", (operation) => {
    expect(HostOperationSchema.safeParse(operation).success).toBe(false);
  });
  it("keeps MCP calls within the ordinary frame limit despite the owner-write allowance", () => {
    const request = {
      v: 1,
      type: "request",
      id: "mcp-call",
      scope: { userId: "owner", spaceId: "space", botId: "bot", runId: "run" },
      operation: {
        op: "mcp.call",
        serverId: "server",
        revision: 1,
        name: "read_fixture",
        args: { input: "x".repeat(HOST_FRAME_BYTES) },
      },
    } as const;
    expect(() => encodeHostFrame(request)).toThrow("Host frame too large");
    expect(() => decodeHostFrame(JSON.stringify(request))).toThrow("Host frame too large");
  });
  it("requires TLS for non-loopback host connections and drops queries", () => {
    expect(hostSocketUrl("http://127.0.0.1:3100/?secret=never")).toBe(
      "ws://127.0.0.1:3100/api/host-bridge/socket",
    );
    expect(hostSocketUrl("https://server.example.test")).toContain("wss:");
    expect(() => hostSocketUrl("http://server.example.test")).toThrow("HTTPS");
    expect(() => hostSocketUrl("https://user:pass@server.example.test")).toThrow();
  });
});
