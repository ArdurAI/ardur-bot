import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  HermesOutput,
  hermesArguments,
  superviseHermesProcess,
  syntheticHermesConfig,
  validateHermesArguments,
} from "./adapters/hermes.js";
import type { Purpose } from "./budget.js";
import { BudgetLedger } from "./budget.js";
import { emptyUsage, openAiUsage, startGateway, UsageCounter } from "./gateway.js";
import { minimalEnvironment } from "./isolation.js";
import { selfTestBudget } from "./self-test.js";

const emit = () => undefined;
describe("Hermes stateful protocol", () => {
  const args = hermesArguments({
    queryFile: "/trial/query.txt",
    workspace: "/trial/workspace",
    modelId: "fixture",
    wallMs: 600000,
  });
  it("uses exact source-supported flags, MCP toolset and scoped resume", () => {
    expect(args).toEqual([
      "chat",
      "--query-file",
      "/trial/query.txt",
      "--oneshot",
      "--provider",
      "custom",
      "--model",
      "fixture",
      "--reasoning",
      "none",
      "--max-turns",
      "12",
      "--run-budget",
      "600",
      "--in",
      "/trial/workspace",
      "--no-restore-cwd",
      "--source",
      "versus",
      "--toolsets",
      "mcp-scoreboard",
    ]);
    expect(
      hermesArguments({
        queryFile: "q",
        workspace: "w",
        modelId: "m",
        wallMs: 1000,
        sessionId: "session-123",
      }).slice(-2),
    ).toEqual(["--resume", "session-123"]);
    expect(() =>
      hermesArguments({
        queryFile: "q",
        workspace: "w",
        modelId: "m",
        wallMs: 1000,
        sessionId: "latest",
      }),
    ).toThrow();
  });
  it.each(["-z", "-Q", "--yolo", "--base-url", "--ignore-user-config", "--safe-mode"])(
    "rejects unsafe or invented flag %s",
    (flag) => expect(() => validateHermesArguments([...args, flag])).toThrow(),
  );
  it("does not confuse fragmented output, banners, denials or session text with content paint or durable admission", () => {
    const events: { kind: string; source: string; data: unknown }[] = [];
    const output = new HermesOutput((kind, source, data) => events.push({ kind, source, data }));
    const wire = Buffer.from(
      "\x1b[32mHermes\x1b[0m\nStarting...\nAnswer: café\nBLOCKED: User denied this command.\nsession_id: trial-session-123\n",
    );
    for (const byte of wire) output.push(Buffer.from([byte]));
    output.end();
    expect(output.sessionId).toBe("trial-session-123");
    expect(
      events.every((event) => event.kind === "diagnostic" && event.source === "product-stdout"),
    ).toBe(true);
    expect(JSON.stringify(events)).toContain("café");
    expect(JSON.stringify(events)).not.toContain("\u001b");
  });
  it("retains final output and flags parser drift or ambiguous session identity", () => {
    const output = new HermesOutput(emit);
    output.push(Buffer.from("session_id: session-one\nsession_id: session-two\n"));
    output.end();
    expect(output.protocolError).toBe("session-identity-changed");
    const unsupported = new HermesOutput(emit);
    unsupported.push(Buffer.from("unrecognized arguments: --new-flag"));
    unsupported.end();
    expect(unsupported.protocolError).toBe("unsupported-flags");
  });
  it("captures streamed and final-panel assistant replies without treating them as paint", () => {
    const output = new HermesOutput(emit);
    const wire = Buffer.from(
      "Query: synthetic-private-sentinel\n╭─⚕ Hermes────────╮\n  Saved café.\n╰────────────────╯\n" +
        "── ⚕ Hermes ────────\n\nFinal artifact saved.\n\n───────────────────\nSession summary\n",
    );
    for (const byte of wire) output.push(Buffer.from([byte]));
    output.end();
    expect(output.reply).toBe("Saved café.\n\nFinal artifact saved.");
    expect(output.protocolError).toBeNull();
    const spaced = new HermesOutput(emit);
    spaced.push(
      Buffer.from(
        "╭─ ⚕ Hermes ────────────────────────────────╮\nSaved the requested result.\n╰──────────────────────────────────────────────╯\n",
      ),
    );
    spaced.end();
    expect(spaced.reply).toBe("Saved the requested result.");
    expect(spaced.protocolError).toBeNull();
  });
  it.each(["unrecognized arguments", "invalid choice", "no such option"])(
    "keeps valid assistant discussion of %s and still detects a failing CLI exit",
    (phrase) => {
      for (const exitCode of [0, 2]) {
        const output = new HermesOutput(emit);
        output.push(
          Buffer.from(`╭─⚕ Hermes──╮\n  The parser reported ${phrase}.\n╰────────────╯\n`),
        );
        output.end(exitCode);
        expect(output.reply).toBe(`The parser reported ${phrase}.`);
        expect(output.protocolError).toBe(exitCode === 0 ? null : "unsupported-flags");
      }
    },
  );
  it("preserves a leaking reply for grading and refuses missing or truncated reply frames", () => {
    const leaking = new HermesOutput(emit);
    leaking.push(Buffer.from("╭─⚕ Hermes──╮\n  synthetic-private-sentinel\n╰────────────╯\n"));
    leaking.end();
    expect(leaking.reply).toBe("synthetic-private-sentinel");
    const missing = new HermesOutput(emit);
    missing.push(Buffer.from("Starting...\n"));
    missing.end();
    expect(missing.reply).toBeNull();
    const truncated = new HermesOutput(emit);
    truncated.push(Buffer.from("╭─⚕ Hermes──╮\n  incomplete"));
    truncated.end();
    expect(truncated.reply).toBeNull();
    expect(truncated.protocolError).toBe("incomplete-assistant-reply");
  });
  it("generates fresh state and pins helpers without inherited owner environment", () => {
    const env = minimalEnvironment("/trial/state", "/install/bin/hermes");
    expect(env.HOME).toBe("/trial/state/home");
    expect(env.HERMES_HOME).toBe("/trial/state/hermes");
    expect(env).not.toHaveProperty("HERMES_YOLO_MODE");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    const config = syntheticHermesConfig(
      selfTestBudget(),
      "http://127.0.0.1:123/c/cap/v1",
      "http://127.0.0.1:124/mcp/cap",
    );
    expect(config.fallback_providers).toEqual([]);
    expect(config.mcp_servers).toHaveProperty("mcp-scoreboard");
    expect(config.security.allow_lazy_installs).toBe(false);
    expect(config.auxiliary.compression.model).toBe(selfTestBudget().model.id);
    expect(config.auxiliary.background_review.enabled).toBe(false);
    expect(config.curator.enabled).toBe(false);
  });
  it.each([
    [
      "final",
      'process.stdout.write("╭─⚕ Hermes──╮\\n  Final result\\n╰────────────╯\\n"); process.stderr.write("session_id: synthetic-session\\n")',
      "completed",
      "process-exited",
    ],
    ["crash", 'process.stdout.write("partial\\n"); process.exit(7)', "failed", "process-crashed"],
    [
      "drift",
      'process.stderr.write("unrecognized arguments: --unsafe\\n")',
      "failed",
      "unsupported-flags",
    ],
    [
      "denial",
      'process.stdout.write("BLOCKED: User denied this command.\\n")',
      "failed",
      "final-reply-unobserved",
    ],
    [
      "malformed",
      'process.stdout.write("x".repeat(5 * 1024 * 1024)); setTimeout(()=>{}, 5000)',
      "failed",
      "malformed-output",
    ],
  ])(
    "supervises the recorded %s subprocess case without invoking Hermes",
    async (_name, script, terminal, reason) => {
      const events: string[] = [];
      const child = spawn(process.execPath, ["-e", script!], {
        detached: true,
        env: { PATH: "/usr/bin:/bin" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const result = await superviseHermesProcess(child, {
        emit: (kind) => events.push(kind),
        signal: new AbortController().signal,
        timeoutMs: 3000,
      });
      expect(result).toMatchObject({ terminal, reason });
      if (_name === "final") expect(result.reply).toBe("Final result");
      expect(events).not.toContain("admission");
      expect(events).not.toContain("approval-decision");
    },
  );
  it.each(["timeout", "cancel"])(
    "terminates and retains the %s process outcome",
    async (scenario) => {
      const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 10000)"], {
        detached: true,
        env: { PATH: "/usr/bin:/bin" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const control = new AbortController();
      const timer = scenario === "cancel" ? setTimeout(() => control.abort(), 100) : undefined;
      try {
        const result = await superviseHermesProcess(child, {
          emit,
          signal: control.signal,
          timeoutMs: scenario === "timeout" ? 100 : 3000,
        });
        expect(result.terminal).toBe(scenario === "timeout" ? "timed-out" : "cancelled");
      } finally {
        clearTimeout(timer);
      }
    },
  );
});

describe("provider gateway", () => {
  it("reserves simultaneous work atomically and retains exposure after cancellation without usage", async () => {
    const budget = selfTestBudget();
    const ledger = new BudgetLedger(budget);
    ledger.open("pending");
    ledger.open("extra");
    let started: () => void = () => undefined;
    const admitted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      started();
      return new Promise<Response>((_resolve, reject) =>
        init.signal!.addEventListener("abort", () => reject(new Error("scripted cancellation")), {
          once: true,
        }),
      );
    });
    const gateway = await startGateway({ budget, ledger, transport, evidenceKind: "virtual" });
    const send = (url: string) =>
      fetch(`${url}/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ model: budget.model.id, messages: [{}] }),
      });
    try {
      const pending = send(gateway.capability("pending", "main", emit));
      await admitted;
      expect((await send(gateway.capability("extra", "helper", emit))).status).toBe(403);
      expect(transport).toHaveBeenCalledTimes(1);
      gateway.revoke("pending");
      await (await pending).text();
      expect(gateway.requests[0]).toMatchObject({
        outcome: "cancelled",
        authoritative: false,
        missingReason: "cancelled-before-usage",
      });
      expect(gateway.requests[0]!.usage).toEqual(emptyUsage());
      expect(ledger.snapshot().reservations[0]).toMatchObject({
        uncertain: true,
        input: budget.contextSize,
        output: budget.maxOutputTokens,
      });
    } finally {
      await gateway.close();
    }
  });
  it("counts every call purpose and refuses an extra upstream request after global denial", async () => {
    const budget = selfTestBudget();
    budget.global.requests = budget.perTrial.requests = 6;
    const ledger = new BudgetLedger(budget);
    ledger.open("trial-a");
    const transport = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: budget.model.id,
            choices: [],
            usage: { prompt_tokens: 100, completion_tokens: 10 },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const gateway = await startGateway({ budget, ledger, transport, evidenceKind: "virtual" });
    try {
      for (const purpose of [
        "main",
        "retry",
        "helper",
        "summary",
        "delegated",
        "detached-learning",
      ] as Purpose[]) {
        const url = gateway.capability("trial-a", purpose, emit);
        const response = await fetch(`${url}/chat/completions`, {
          method: "POST",
          body: JSON.stringify({
            model: budget.model.id,
            messages: [{ role: "user", content: "synthetic" }],
          }),
        });
        expect(response.status).toBe(200);
        await response.text();
      }
      const url = gateway.capability("trial-a", "main", emit);
      expect(
        (
          await fetch(`${url}/chat/completions`, {
            method: "POST",
            body: JSON.stringify({ model: budget.model.id, messages: [{}] }),
          })
        ).status,
      ).toBe(403);
      expect(transport).toHaveBeenCalledTimes(6);
      expect(gateway.requests.map((request) => request.purpose)).toHaveLength(6);
      expect(gateway.requests[0]?.usage.cacheReadInput).toBeNull();
      gateway.revoke("trial-a");
      expect((await fetch(`${url}/models`)).status).toBe(403);
    } finally {
      await gateway.close();
    }
  });
  it("rejects route, seed and multi-completion drift before transport", async () => {
    const budget = selfTestBudget();
    const ledger = new BudgetLedger(budget);
    ledger.open("trial");
    const transport = vi.fn();
    const gateway = await startGateway({ budget, ledger, transport, evidenceKind: "virtual" });
    const url = gateway.capability("trial", "main", emit);
    try {
      for (const change of [
        { model: "wrong" },
        { seed: 1 },
        { temperature: 2 },
        { n: 2 },
        { messages: [{ content: [{ image_url: "http://example.test" }] }] },
      ]) {
        const response = await fetch(`${url}/chat/completions`, {
          method: "POST",
          body: JSON.stringify({
            model: budget.model.id,
            messages: [{ role: "user", content: "test" }],
            ...change,
          }),
        });
        expect(response.status).toBe(403);
      }
      expect(transport).not.toHaveBeenCalled();
      expect(ledger.reservations).toHaveLength(0);
    } finally {
      await gateway.close();
    }
  });
  it("parses split SSE content and retains unknown usage on cancellation", async () => {
    const budget = selfTestBudget();
    const ledger = new BudgetLedger(budget);
    ledger.open("stream");
    const events: unknown[] = [];
    const wire = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';
    const gateway = await startGateway({
      budget,
      ledger,
      evidenceKind: "virtual",
      transport: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const byte of Buffer.from(wire)) controller.enqueue(Uint8Array.of(byte));
              controller.close();
            },
          }),
        ),
    });
    try {
      const url = gateway.capability("stream", "main", (_kind, _source, data) => events.push(data));
      const response = await fetch(`${url}/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ model: budget.model.id, messages: [{}], stream: true }),
      });
      expect(await response.text()).toBe(wire);
      expect(gateway.requests[0]?.missingReason).toBe("provider-omitted");
      expect(ledger.snapshot().reservations[0]?.uncertain).toBe(true);
      expect(JSON.stringify(events)).toContain('"text":"ok"');
    } finally {
      await gateway.close();
    }
  });
  it("never fabricates missing cache/reasoning zeros or accepts impossible partitions", () => {
    expect(openAiUsage({ prompt_tokens: 100, completion_tokens: 20 })).toEqual({
      ...emptyUsage(),
      logicalInput: 100,
      output: 20,
    });
    expect(() =>
      openAiUsage({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 12 } }),
    ).toThrow();
    expect(() =>
      openAiUsage({ completion_tokens: 10, completion_tokens_details: { reasoning_tokens: 12 } }),
    ).toThrow();
  });
  it("normalizes cumulative counters by declared epoch, retaining missing categories", () => {
    const counter = new UsageCounter();
    expect(counter.delta("epoch-one", 0, { ...emptyUsage(), logicalInput: 10 }).logicalInput).toBe(
      10,
    );
    expect(counter.delta("epoch-one", 1, { ...emptyUsage(), logicalInput: 14 }).logicalInput).toBe(
      4,
    );
    expect(() => counter.delta("epoch-one", 2, { ...emptyUsage(), logicalInput: 3 })).toThrow(
      "decreased",
    );
    expect(counter.delta("epoch-two", 0, { ...emptyUsage(), logicalInput: 3 }).logicalInput).toBe(
      3,
    );
    expect(
      counter.delta("epoch-two", 1, { ...emptyUsage(), logicalInput: 4 }).reasoning,
    ).toBeNull();
  });
});
