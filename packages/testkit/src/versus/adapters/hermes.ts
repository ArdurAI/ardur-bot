import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";
import { contentDigest } from "../../scoreboard/manifest.js";
import type { TrialBroker } from "../broker.js";
import type { Budget } from "../budget.js";
import { requireValue } from "../budget.js";
import type { IsolationProof, NativePolicy } from "../isolation.js";
import {
  assertNativeProductIsolation,
  assertOwnedTrial,
  nativeProfile,
  prepareEnvironment,
} from "../isolation.js";
import { inspectHermes, sanitize } from "../provenance.js";
import { sampleProcessTree, summarizeResources } from "../resources.js";
import type { Emit, TrialArtifacts, TrialContext, VersusAdapter } from "./types.js";

export function hermesArguments(input: {
  queryFile: string;
  workspace: string;
  modelId: string;
  wallMs: number;
  sessionId?: string;
}) {
  if (input.sessionId)
    requireValue(
      /^[a-zA-Z0-9_-]{8,120}$/.test(input.sessionId) && input.sessionId !== "latest",
      "Exact assigned session identity required",
    );
  const args = [
    "chat",
    "--query-file",
    input.queryFile,
    "--oneshot",
    "--provider",
    "custom",
    "--model",
    input.modelId,
    "--reasoning",
    "none",
    "--max-turns",
    "12",
    "--run-budget",
    String(input.wallMs / 1000),
    "--in",
    input.workspace,
    "--no-restore-cwd",
    "--source",
    "versus",
    "--toolsets",
    "mcp-scoreboard",
  ];
  if (input.sessionId) args.push("--resume", input.sessionId);
  validateHermesArguments(args);
  return args;
}
export function validateHermesArguments(args: string[]) {
  requireValue(
    args[0] === "chat" && args.includes("--oneshot") && args.includes("--query-file"),
    "Primary lane requires stateful chat --oneshot",
  );
  const flags = new Set([
    "--query-file",
    "--oneshot",
    "--provider",
    "--model",
    "--reasoning",
    "--max-turns",
    "--run-budget",
    "--in",
    "--no-restore-cwd",
    "--source",
    "--toolsets",
    "--resume",
  ]);
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index++) {
    const flag = args[index]!;
    requireValue(flags.has(flag) && !seen.has(flag), "Unsupported or repeated Hermes flag");
    seen.add(flag);
    if (!["--oneshot", "--no-restore-cwd"].includes(flag)) {
      const value = args[++index];
      requireValue(value && !value.startsWith("--"), "Missing Hermes argument");
      if (flag === "--resume")
        requireValue(
          value !== "latest" && /^[a-zA-Z0-9_-]{8,120}$/.test(value),
          "Exact resume identity required",
        );
    }
  }
}
export function syntheticHermesConfig(budget: Budget, providerUrl: string, brokerUrl: string) {
  const aux = {
    provider: "custom",
    model: budget.model.id,
    base_url: providerUrl,
    api_key: "local",
    reasoning_effort: "none",
    max_output_tokens: budget.maxOutputTokens,
    timeout: Math.min(120, budget.perTrial.wallMs / 1000),
  };
  return {
    model: {
      default: budget.model.id,
      provider: "custom",
      base_url: providerUrl,
      api_key: "local",
      context_length: budget.contextSize,
      max_output_tokens: budget.maxOutputTokens,
    },
    fallback_providers: [],
    toolsets: ["mcp-scoreboard"],
    agent: {
      max_turns: 12,
      run_budget_seconds: budget.perTrial.wallMs / 1000,
      reasoning_effort: "none",
      temperature: budget.temperature,
    },
    mcp_servers: { scoreboard: { url: brokerUrl, transport: "http" } },
    auxiliary: {
      vision: aux,
      compression: aux,
      approval: aux,
      mcp: aux,
      skills_hub: aux,
      review: aux,
      title_generation: { ...aux, enabled: false },
      background_review: { ...aux, enabled: false },
    },
    delegation: {
      provider: "custom",
      model: budget.model.id,
      base_url: providerUrl,
      api_key: "local",
      max_iterations: 12,
    },
    memory: { memory_enabled: true, user_profile_enabled: true, provider: "", nudge_interval: 0 },
    skills: {
      external_dirs: [],
      trusted_project_dirs: [],
      project_discovery: false,
      inline_shell: false,
    },
    curator: { enabled: false, consolidate: false },
    hooks: {},
    plugins: {},
    display: { interface: "cli" },
  };
}

/** Stdout is retained as rendering evidence only. It cannot attest durable admission or approval. */
export class HermesOutput {
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";
  private bytes = 0;
  private responseLines: string[] | null = null;
  private responses: string[] = [];
  private responseFrame: "stream" | "panel" | null = null;
  sessionId: string | null = null;
  protocolError: string | null = null;
  get reply(): string | null {
    return this.responses.length ? this.responses.join("\n\n") : null;
  }
  constructor(
    private readonly emit: Emit,
    private readonly redact: string[] = [],
  ) {}
  push(bytes: Uint8Array) {
    this.bytes += bytes.length;
    requireValue(this.bytes <= 4 * 1024 * 1024, "Hermes output byte limit");
    this.pending += this.decoder.write(Buffer.from(bytes));
    let index = this.pending.indexOf("\n");
    while (index !== -1) {
      this.line(this.pending.slice(0, index));
      this.pending = this.pending.slice(index + 1);
      index = this.pending.indexOf("\n");
    }
  }
  end() {
    this.pending += this.decoder.end();
    if (this.pending) this.line(this.pending);
    this.pending = "";
    if (this.responseLines !== null) this.protocolError = "incomplete-assistant-reply";
  }
  private line(raw: string) {
    const line = stripVTControlCharacters(raw).replace(/\r/g, "");
    // Source: cli_stream_mixin's response box and cli_chat_turn_mixin's HORIZONTALS panel.
    // Keep unsanitized assistant text for the hidden grader; diagnostics are redacted separately.
    const streamHeader = /^\s*╭─+\s*⚕ Hermes(?: \d{2}:\d{2}(?::\d{2})?)?─+╮\s*$/.test(line);
    const panelHeader = /^\s*─+\s+⚕ Hermes\s+─+\s*$/.test(line);
    if (streamHeader || panelHeader) {
      if (this.responseLines !== null) this.protocolError = "ambiguous-assistant-reply";
      this.responseFrame = streamHeader ? "stream" : "panel";
      this.responseLines = [];
    } else if (this.responseLines !== null) {
      const closes =
        this.responseFrame === "stream" ? /^\s*╰─+╯\s*$/.test(line) : /^\s*─{3,}\s*$/.test(line);
      if (closes) {
        this.responses.push(this.responseLines.join("\n").trim());
        this.responseLines = null;
        this.responseFrame = null;
      } else {
        this.responseLines.push(this.responseFrame === "stream" ? line.replace(/^ {2}/, "") : line);
      }
    }
    const session = /^\s*session_id: ([a-zA-Z0-9_-]{8,120})\s*$/.exec(line);
    if (session) {
      if (this.sessionId && this.sessionId !== session[1])
        this.protocolError = "session-identity-changed";
      this.sessionId = session[1]!;
    }
    if (/unrecognized arguments|no such option|invalid choice/i.test(line))
      this.protocolError = "unsupported-flags";
    this.emit("diagnostic", "product-stdout", {
      text: sanitize(line, this.redact),
      renderBoundary: "unclassified-cli-output",
      userTtft: null,
    });
  }
}

/** Shared by the native adapter and scripted subprocess tests. No model or product is selected here. */
export async function superviseHermesProcess(
  child: ChildProcess,
  options: { emit: Emit; signal: AbortSignal; timeoutMs: number; redact?: string[] },
) {
  const stdout = new HermesOutput(options.emit, options.redact);
  const stderr = new HermesOutput(options.emit, options.redact);
  let reason: string | null = null;
  let terminal: TrialArtifacts["observation"]["terminal"] = "uncertain";
  const kill = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      /* This process group already exited. */
    }
  };
  let escalation: NodeJS.Timeout | undefined;
  const stop = (outcome: typeof terminal, why: string) => {
    if (reason) return;
    terminal = outcome;
    reason = why;
    kill("SIGTERM");
    escalation = setTimeout(() => kill("SIGKILL"), 1000);
  };
  const cancel = () => stop("cancelled", "cancelled");
  options.signal.addEventListener("abort", cancel, { once: true });
  const deadline = setTimeout(() => stop("timed-out", "deadline"), options.timeoutMs);
  const consume = (parser: HermesOutput, chunk: Buffer) => {
    try {
      parser.push(chunk);
    } catch {
      stop("failed", "malformed-output");
    }
  };
  child.stdout?.on("data", (chunk: Buffer) => consume(stdout, chunk));
  child.stderr?.on("data", (chunk: Buffer) => consume(stderr, chunk));
  try {
    const done = new Promise<number | null>((resolve) => {
      child.once("error", () => {
        reason = "process-start-failed";
        terminal = "failed";
        resolve(null);
      });
      child.once("close", resolve);
    });
    if (options.signal.aborted) cancel();
    const code = await done;
    stdout.end();
    stderr.end();
    const sessions = [stdout.sessionId, stderr.sessionId].filter((id): id is string => id !== null);
    const protocolError =
      stdout.protocolError ??
      stderr.protocolError ??
      (new Set(sessions).size > 1 ? "session-identity-changed" : null) ??
      (code === 0 && stdout.reply === null ? "final-reply-unobserved" : null);
    if (!reason) {
      reason = protocolError ?? (code === 0 ? "process-exited" : "process-crashed");
      terminal = code === 0 && !protocolError ? "completed" : "failed";
    }
    return { terminal, reason, sessionId: sessions[0] ?? null, reply: stdout.reply };
  } finally {
    clearTimeout(deadline);
    clearTimeout(escalation);
    options.signal.removeEventListener("abort", cancel);
    kill("SIGKILL"); // Reap remaining members of the invocation-owned process group.
  }
}

export class HermesAdapter implements VersusAdapter {
  readonly product = "hermes" as const;
  private context: TrialContext | null = null;
  private child: ChildProcess | null = null;
  private env: NodeJS.ProcessEnv = {};
  private control = new AbortController();
  private operation: Promise<void> | null = null;
  private args: string[] = [];
  private terminal: TrialArtifacts["observation"]["terminal"] = "uncertain";
  private reason = "not-submitted";
  private reply: string | null = null;
  private started = 0;
  private elapsed = 0;
  private assignedSession: string | null = null;
  readonly resourceSamples: ReturnType<typeof summarizeResources>[] = [];
  constructor(
    private readonly options: {
      executable: string;
      source: string;
      expectedRevision: string;
      proof: IsolationProof;
      policy: NativePolicy;
      broker: TrialBroker;
      longitudinal?: boolean;
      observedRoute?: () => { endpoint: string; model: string; digest: string } | null;
    },
  ) {}
  async inspect() {
    return { ...(await inspectHermes(this.options)).identity };
  }
  async prepare(context: TrialContext) {
    requireValue(!this.context, "Adapter already prepared");
    await assertOwnedTrial(context.workspace, context.stateDirectory);
    const inspected = await inspectHermes(this.options);
    requireValue(inspected.identity.revisionMatches, "Hermes revision mismatch");
    assertNativeProductIsolation(this.options.proof, this.options.policy);
    const journal = path.resolve(this.options.broker.options.journal);
    requireValue(
      !journal.startsWith(`${this.options.policy.root}/`) &&
        this.options.policy.forbiddenRoots.some(
          (root) => journal === root || journal.startsWith(`${root}/`),
        ),
      "Broker receipt journal must be outside product authority and explicitly denied",
    );
    requireValue(
      context.workspace.startsWith(`${this.options.policy.root}/`) &&
        context.stateDirectory.startsWith(`${this.options.policy.root}/`),
      "Trial outside tested policy",
    );
    this.context = context;
    this.env = await prepareEnvironment(context.stateDirectory, this.options.executable);
    this.env.OPENAI_BASE_URL = context.providerUrl;
    this.env.OPENAI_API_KEY = "local";
    const config = syntheticHermesConfig(context.budget, context.providerUrl, context.brokerUrl);
    // JSON is a YAML subset. This is a new synthetic config, never a copy of owner settings.
    await writeFile(path.join(this.env.HERMES_HOME!, "config.yaml"), JSON.stringify(config), {
      flag: "wx",
      mode: 0o600,
    });
    const queryFile = path.join(context.stateDirectory, "query.txt");
    await writeFile(
      queryFile,
      `${context.task.prompt}\nInput files: ${Object.keys(context.task.files).join(", ")}.`,
      { flag: "wx", mode: 0o600 },
    );
    this.args = hermesArguments({
      queryFile,
      workspace: context.workspace,
      modelId: context.budget.model.id,
      wallMs: Math.min(context.task.deadlineMs, context.budget.perTrial.wallMs),
    });
    context.emit("diagnostic", "product-process", {
      configHash: contentDigest(sanitize(JSON.stringify(config))),
      command: [
        "<hermes-executable>",
        ...this.args.map((arg) => sanitize(arg, [context.workspace, queryFile])),
      ],
      actualCommandHash: contentDigest([this.options.executable, ...this.args]),
      binaryHash: inspected.identity.binaryHash,
    });
  }
  async submit() {
    requireValue(!this.child && this.context, "Hermes trial not ready");
    this.operation = this.run();
    await this.operation;
  }
  async resume(sessionId: string) {
    requireValue(
      this.options.longitudinal && sessionId === this.assignedSession && !this.child,
      "Resume must use the assigned longitudinal session",
    );
    this.args = [
      ...this.args.filter(
        (arg, index, args) => arg !== "--resume" && args[index - 1] !== "--resume",
      ),
      "--resume",
      sessionId,
    ];
    this.operation = this.run();
    await this.operation;
  }
  private async run() {
    const context = this.context!;
    requireValue(!context.signal.aborted, "Trial cancelled before startup");
    validateHermesArguments(this.args);
    this.control = new AbortController();
    this.reason = "not-submitted";
    this.reply = null;
    assertNativeProductIsolation(this.options.proof, this.options.policy);
    this.started = performance.now();
    const child = spawn(
      "/usr/bin/sandbox-exec",
      ["-p", nativeProfile(this.options.policy), this.options.executable, ...this.args],
      {
        cwd: context.workspace,
        env: this.env,
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.child = child;
    const cancel = () => {
      void this.cancel();
    };
    context.signal.addEventListener("abort", cancel, { once: true });
    let sampling = false;
    const sampler = setInterval(() => {
      if (!child.pid || sampling) return;
      sampling = true;
      void sampleProcessTree([child.pid])
        .then((samples) => {
          const measurement = summarizeResources(samples);
          this.resourceSamples.push(measurement);
          if (
            measurement.productRssBytes > context.budget.resources.memoryBytes ||
            measurement.productCpuMs > context.budget.resources.cpuMs ||
            samples.length > context.budget.resources.processes
          ) {
            this.reason = "resource-budget-exhausted";
            void this.cancel();
          }
        })
        .catch(() => {
          this.reason = "resource-monitor-unavailable";
          void this.cancel();
        })
        .finally(() => {
          sampling = false;
        });
    }, context.budget.resources.sampleMs);
    try {
      const outcome = await superviseHermesProcess(child, {
        emit: context.emit,
        signal: this.control.signal,
        timeoutMs: Math.min(context.task.deadlineMs, context.budget.perTrial.wallMs),
        redact: [
          context.workspace,
          context.stateDirectory,
          this.options.source,
          this.options.executable,
        ],
      });
      this.terminal = outcome.terminal;
      this.reply = outcome.reply;
      this.assignedSession = outcome.sessionId;
      if (this.reason === "not-submitted") this.reason = outcome.reason;
    } finally {
      context.revokeProvider();
      this.elapsed = performance.now() - this.started;
      clearInterval(sampler);
      context.signal.removeEventListener("abort", cancel);
      this.child = null;
      context.emit("terminal", "product-process", {
        terminal: this.terminal,
        reason: this.reason,
        durableAdmission: "not-observed",
      });
    }
  }
  async cancel() {
    this.control.abort();
    this.context?.revokeProvider();
  }
  async collect(): Promise<TrialArtifacts> {
    requireValue(this.context && !this.child, "Collect only after terminal process");
    requireValue(this.reply !== null, "Hermes final assistant reply was not observed");
    const snapshot = await this.options.broker.snapshot();
    let result: unknown = null;
    try {
      result = JSON.parse(snapshot.files["result.json"] ?? "null");
    } catch {
      this.reason = "invalid-artifact";
    }
    const pin = {
      endpoint: this.context.budget.endpoint.origin,
      model: this.context.budget.model.id,
      digest: this.context.budget.model.digest,
    };
    return {
      observation: {
        ...snapshot,
        result,
        reply: this.reply,
        expectedPin: pin,
        observedPin: this.options.observedRoute?.() ?? null,
        elapsedMs: this.elapsed,
        terminal: this.terminal,
      },
      outcomeReason: this.reason,
      sessionId: this.assignedSession,
      userTtft: null,
      userTtftMissingReason: "CLI paint boundary and interactive approval driver are not qualified",
    };
  }
  async destroy() {
    await this.cancel();
    await this.operation; // Wait before allowing the supervisor to remove the owned filesystem.
  }
}
