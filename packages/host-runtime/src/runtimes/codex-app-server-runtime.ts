import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
} from "@ardurbot/adapter-kit";
import type { RuntimeAvailability } from "@ardurbot/contracts/runtime-pins";
import { RuntimePinError, runtimePinProblem } from "@ardurbot/contracts/runtime-pins";
import * as z from "zod";
import type { HostGuardrailConfig } from "../host-guardrails.js";
import {
  guardrailConfigFromEnv,
  isGuardedPath,
  resolveGuardrailPathsSync,
  resolveRealPathSync,
} from "../host-guardrails.js";
import { startArdurMcpServer } from "./ardur-mcp-server.js";
import { createArdurToolBridge } from "./claude-mcp-bridge.js";
import { CodexUsageCollector } from "./codex-usage.js";
import {
  nativeFailureCategory,
  nativeFailureDetail,
  nativeFailureProblem,
} from "./native-failure-signals.js";
import type { NativeSpawn } from "./native-process.js";
import {
  findNativeBinary,
  guardedSpawn,
  jsonLines,
  probeCommand,
  RuntimeQueue,
  sessionSpawnFor,
  spawnNative,
  stopNative,
} from "./native-process.js";

type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};

class CodexRequestRejected extends Error {
  constructor(readonly code?: number) {
    super("Codex app-server rejected the request.");
  }
}

/** Bounded stdio RPC. No server output or account details are logged. */
export class CodexRpc {
  readonly events = new RuntimeQueue<RpcMessage>();
  onMessage?: (message: RpcMessage) => void;
  private nextId = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private reader: Promise<void>;
  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stderr.resume();
    child.once("error", () => this.fail());
    this.reader = (async () => {
      try {
        for await (const message of jsonLines(child)) {
          const item = message as RpcMessage;
          this.onMessage?.(item);
          const pending =
            typeof item.id === "number" && !item.method ? this.pending.get(item.id) : undefined;
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(item.id as number);
            if (item.error)
              pending.reject(new CodexRequestRejected((item.error as { code?: number }).code));
            else pending.resolve(item.result);
          } else this.events.push(item);
        }
        this.fail();
      } catch {
        this.fail();
      }
    })();
  }
  private fail() {
    const error = new Error("Codex app-server unavailable");
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.events.end(error);
  }
  send(message: RpcMessage) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Codex app-server unavailable"));
      }, 15_000);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      this.send({ id, method, params });
    });
  }
  async initialize() {
    await this.request("initialize", {
      clientInfo: { name: "ardur-bot", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: "initialized" });
  }
  async close() {
    await stopNative(this.child);
    await this.reader;
  }
}

const disabledFeatures = [
  "plugins",
  "shell_tool",
  "unified_exec",
  "hooks",
  "apps",
  "multi_agent",
  "memories",
  "remote_plugin",
  "skill_mcp_dependency_install",
];
export function codexArguments() {
  return [
    "app-server",
    ...disabledFeatures.flatMap((name) => ["-c", `features.${name}=false`]),
    "-c",
    'web_search="disabled"',
    "-c",
    "features.view_image=false",
  ];
}
/** Codex's instruction settings, as returned by config/read. */
export type InstructionDiscovery = {
  rootMarkers?: unknown;
  fallbackFilenames?: unknown;
  maxBytes?: unknown;
};
const DEFAULT_ROOT_MARKERS = [".git"];
/** In the order Codex prefers them: a folder's override stands in for its AGENTS.md. */
const INSTRUCTION_FILENAMES = ["AGENTS.override.md", "AGENTS.md"];
/** Codex's own default limit for project instructions, and the most Ardur will load. */
const INSTRUCTION_BYTES_DEFAULT = 32 * 1024;
const INSTRUCTION_BYTES_LIMIT = 256 * 1024;
const PROJECT_INSTRUCTIONS_HEADING = "Project instructions (from the folder's instruction files):";
function plainNames(value: unknown, fallback: string[]): string[] {
  const names = Array.isArray(value)
    ? value.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.length > 0 && !/[/\\\0]/.test(entry),
      )
    : [];
  return names.length ? names : fallback;
}
function instructionBytes(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    return INSTRUCTION_BYTES_DEFAULT;
  return Math.min(value, INSTRUCTION_BYTES_LIMIT);
}
/** True when `candidate` is `base` or sits inside it, ignoring case where the disk does. */
const within = (base: string, candidate: string) => isGuardedPath([base], candidate);

/** An instruction file Ardur will not read: it would bring in a file from somewhere else. */
export class UnsafeInstructionFileError extends Error {
  constructor(readonly filename: string) {
    super(`Unsafe instruction file: ${filename}`);
    this.name = "UnsafeInstructionFileError";
  }
}

export type ProjectInstructions = {
  /** The instruction files' text, outermost folder first. Empty when there is none. */
  text: string;
  /** The files it came from, as the disk spells them. */
  sources: string[];
  /** The folders that were searched, from the project root down to the bot's folder. */
  directories: string[];
};

/**
 * One instruction file, read through a file that is opened first and checked second, so
 * what is checked is what is read. The file must be an ordinary file with one name, inside
 * the project, outside protected data, and still where it was found once it is open.
 */
async function readInstructionFile(
  file: string,
  project: string,
  guarded: string[],
  limit: number,
): Promise<{ real: string; text: string }> {
  const real = await realpath(file);
  if (!within(project, real) || isGuardedPath(guarded, real)) throw new Error("outside");
  // Without waiting: a named pipe with no writer would hold a plain open forever.
  const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const [held, named, still] = await Promise.all([
      handle.stat({ bigint: true }),
      stat(real, { bigint: true }),
      realpath(real),
    ]);
    if (
      !held.isFile() ||
      held.nlink > 1n ||
      still !== real ||
      named.dev !== held.dev ||
      named.ino !== held.ino
    )
      throw new Error("changed");
    const size = Number(held.size < BigInt(limit) ? held.size : BigInt(limit));
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    return { real, text: buffer.subarray(0, bytesRead).toString("utf8") };
  } finally {
    await handle.close();
  }
}

/**
 * The project instructions for a folder: AGENTS.md, its override or a configured fallback
 * name, one per folder, from the folder's project root (the nearest ancestor holding a
 * configured root marker) down to the folder itself, or only the folder's own when no root is
 * found. It follows Codex's own rules and limit.
 *
 * Ardur reads these files and hands Codex the text, and Codex's own loading is turned off.
 * Codex follows links in what it reads, with no way to check the file it ends up with; read
 * here, each file is checked after it is opened. One that cannot be read safely refuses the
 * session: a link out of the project, a second name for a file elsewhere, a folder, a broken
 * link or protected data.
 */
export async function loadProjectInstructions(
  cwd: string,
  discovery: InstructionDiscovery = {},
  guarded: string[] = [],
): Promise<ProjectInstructions> {
  const markers = plainNames(discovery.rootMarkers, DEFAULT_ROOT_MARKERS);
  const filenames = [
    ...new Set([...INSTRUCTION_FILENAMES, ...plainNames(discovery.fallbackFilenames, [])]),
  ];
  const folder = resolveRealPathSync(path.resolve(cwd));
  const chain: string[] = [];
  let directory = folder;
  let root: string | undefined;
  for (let depth = 0; depth < 64 && !root; depth++) {
    chain.push(directory);
    for (const marker of markers) {
      if (
        await access(path.join(directory, marker)).then(
          () => true,
          () => false,
        )
      ) {
        root = directory;
        break;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const directories = (root ? chain : chain.slice(0, 1)).reverse();
  const project = directories[0] ?? folder;
  const parts: string[] = [];
  const sources: string[] = [];
  let remaining = instructionBytes(discovery.maxBytes);
  for (const entry of directories) {
    if (remaining <= 0) break;
    for (const name of filenames) {
      const file = path.join(entry, name);
      if (!(await lstat(file).catch(() => undefined))) continue;
      const loaded = await readInstructionFile(file, project, guarded, remaining).catch(() => {
        throw new UnsafeInstructionFileError(name);
      });
      remaining -= Buffer.byteLength(loaded.text);
      if (loaded.text.trim()) {
        parts.push(loaded.text.trim());
        sources.push(loaded.real);
      }
      // The first name a folder holds is the one Codex would load for it.
      break;
    }
  }
  return { text: parts.join("\n\n"), sources, directories };
}

/**
 * Codex also loads an instruction file from its own folder, which Ardur cannot turn off. After
 * a session starts and before any turn is sent, every file Codex says it loaded must be an
 * ordinary file outside protected data and outside the project (whose files Ardur supplied),
 * and neither its name nor its content may have changed since just before the session was
 * asked for. A file swapped for a link and put back leaves its change time behind.
 */
export async function trustedInstructionSources(
  sources: unknown,
  check: { directories: string[]; guarded: string[]; askedAtMs: number },
): Promise<boolean> {
  // Codex always reports the list, empty when it loaded nothing. No list is no evidence.
  if (!Array.isArray(sources)) return false;
  const asked = BigInt(Math.floor(check.askedAtMs)) * 1_000_000n;
  const fromProject = (file: string) =>
    check.directories.some(
      (directory) => within(directory, path.dirname(file)) && within(path.dirname(file), directory),
    );
  for (const source of sources) {
    if (typeof source !== "string" || !path.isAbsolute(source)) return false;
    const entry = await lstat(source, { bigint: true }).catch(() => undefined);
    const real = await realpath(source).catch(() => undefined);
    const target = real ? await stat(real, { bigint: true }).catch(() => undefined) : undefined;
    if (
      !entry ||
      !real ||
      !target?.isFile() ||
      entry.ctimeNs >= asked ||
      target.ctimeNs >= asked ||
      isGuardedPath(check.guarded, real) ||
      fromProject(source) ||
      fromProject(real)
    )
      return false;
  }
  return true;
}

export async function openCodex(start: NativeSpawn = spawnNative) {
  const binary = await findNativeBinary("codex");
  if (!binary) throw new Error("Codex app-server unavailable");
  const rpc = new CodexRpc(start(binary, codexArguments()));
  try {
    await rpc.initialize();
    return rpc;
  } catch (error) {
    await rpc.close();
    throw error;
  }
}

type CodexModel = {
  model: string;
  displayName: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string }>;
};
export async function codexModels(rpc: CodexRpc): Promise<RuntimeAvailability["models"]> {
  const models: RuntimeAvailability["models"] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const page: { data: CodexModel[]; nextCursor: string | null } = await rpc.request(
      "model/list",
      { cursor, includeHidden: false },
    );
    if (models.length + page.data.length > 1024) throw new Error("Model catalog is too large.");
    for (const entry of page.data)
      models.push({
        id: entry.model,
        label: entry.displayName,
        efforts: entry.supportedReasoningEfforts
          .map((effort) => effort.reasoningEffort)
          .filter((effort) => ["low", "medium", "high", "xhigh", "minimal"].includes(effort)),
      });
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error("Invalid model catalog cursor.");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return models;
}

export async function probeCodex(start?: NativeSpawn): Promise<RuntimeAvailability> {
  const launch = start ?? guardedSpawn();
  const base = { runtimeKind: "codex-app-server" as const, models: [] };
  let rpc: CodexRpc | undefined;
  let version: string | undefined;
  let signedIn: boolean | undefined;
  try {
    const binary = await findNativeBinary("codex");
    if (!binary) return { ...base, available: false, reason: "Codex is not installed." };
    const result = await probeCommand(binary, ["--version"], true, launch);
    version = result.version;
    if (result.code !== 0) throw new Error("version probe failed");
    rpc = await openCodex(launch);
    const { account } = await rpc.request<{ account: { type: string } | null }>("account/read", {
      refreshToken: false,
    });
    signedIn = account?.type === "chatgpt";
    if (!signedIn)
      return {
        ...base,
        version,
        signedIn,
        available: false,
        reason: "Not signed in — run codex login.",
      };
    return { ...base, version, signedIn, available: true, models: await codexModels(rpc) };
  } catch (error) {
    return {
      ...base,
      version,
      signedIn,
      available: false,
      reason:
        version &&
        error instanceof CodexRequestRejected &&
        [-32601, -32602].includes(error.code ?? 0)
          ? `Codex version ${version} is not supported yet.`
          : "Codex could not be reached. Check again or restart the desktop app.",
    };
  } finally {
    await rpc?.close();
  }
}

export class CodexAppServerRuntime implements AgentRuntime {
  private running = new Map<string, () => Promise<void>>();
  constructor(
    // Codex applies its own sandbox, so its session runs outside the Seatbelt wrap
    // (NATIVE_SESSION_GUARD). The guard's paths are still enforced on Codex's own profile.
    private readonly start: NativeSpawn = sessionSpawnFor("codex-app-server"),
    private readonly guard: HostGuardrailConfig = guardrailConfigFromEnv(),
  ) {}
  describe() {
    return {
      id: "codex-app-server",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { streaming: true, compaction: false, tools: true, scripted: false },
    };
  }
  async abort(runId: string) {
    await this.running.get(runId)?.();
  }
  async *run(
    request: AgentRunRequest,
    context?: Partial<AdapterContext>,
  ): AsyncIterable<AgentRuntimeEvent> {
    const pin = request.model.runtimePin!;
    const problem = (
      code: "runtime-unavailable" | "pin-model-unknown" | "pin-effort-unsupported",
      reason: string,
    ) => new RuntimePinError(runtimePinProblem(pin, code, reason));
    if (
      request.model.apiKey ||
      request.model.oauth ||
      (pin.credentialId && pin.credentialId !== "native:codex-app-server")
    )
      throw problem(
        "runtime-unavailable",
        "Codex uses its own ChatGPT sign-in. Remove the pinned connection or change the runtime.",
      );
    // Codex runs under its own sandbox, so Ardur's protected paths are enforced on its
    // profile here: the bot's folder may not sit inside them or contain them, and no
    // instruction file from them is granted. Codex follows links in its folder and in what
    // it is granted, so the folder is checked, granted and handed to Codex as the disk
    // spells it. (Codex's own sandbox cannot even enter a folder reached through a link.)
    const guarded = resolveGuardrailPathsSync(this.guard.paths);
    const folder = request.nativeCwd
      ? resolveRealPathSync(path.resolve(request.nativeCwd))
      : undefined;
    if (
      folder &&
      (isGuardedPath(guarded, folder) || guarded.some((entry) => isGuardedPath([folder], entry)))
    )
      throw problem(
        "runtime-unavailable",
        "Codex could not start a session in this bot's folder — change the bot's computer or the pin.",
      );
    const rpc = await openCodex((binary, args) => this.start(binary, args, folder)).catch(() => {
      throw problem("runtime-unavailable", "Codex app-server unavailable");
    });
    const queue = new RuntimeQueue<AgentRuntimeEvent>();
    let threadId: string | undefined;
    let turnId: string | undefined;
    let paused = false;
    let pinValid = false;
    let finished = false;
    const usage = new CodexUsageCollector(
      pin.provider!,
      pin.modelId!,
      Boolean(request.nativeSession?.sessionId),
    );
    let usageStarted = false;
    let usageFinished = false;
    let interrupted = false;
    let usageBarrier: RpcMessage | undefined;
    let completionHandled = false;
    let reader: Promise<void> | undefined;
    let steering: ReturnType<typeof setInterval> | undefined;
    const interrupt = async () => {
      interrupted = true;
      if (threadId && turnId)
        await rpc.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
      if (usageStarted && !usageFinished) {
        queue.push(
          usage.finish(
            context?.signal?.reason?.name === "TimeoutError" ? "timed-out" : "cancelled",
            false,
          ),
        );
        usageFinished = true;
      }
      queue.end();
    };
    const abort = () => {
      void interrupt();
    };
    this.running.set(request.runId, interrupt);
    const bridge = createArdurToolBridge(
      request,
      (event) => queue.push(event),
      () => {
        paused = true;
        void interrupt();
      },
      () => pinValid && !paused && !context?.signal?.aborted,
    );
    rpc.onMessage = (message) => {
      if (
        !usageStarted &&
        request.nativeSession?.sessionId &&
        message.method === "thread/tokenUsage/updated" &&
        message.params?.threadId === request.nativeSession.sessionId
      ) {
        usage.seed((message.params.tokenUsage as { total?: unknown } | undefined)?.total);
      }
      if (message.method === "model/rerouted") {
        pinValid = false;
        queue.end(problem("pin-model-unknown", "Codex rerouted the pinned model."));
        void interrupt();
      }
    };
    const mcp = await startArdurMcpServer(bridge).catch(async () => {
      await rpc.close();
      this.running.delete(request.runId);
      throw problem("runtime-unavailable", "Codex tools could not start — change the pin.");
    });
    try {
      const { account } = await rpc.request<{ account: { type: string } | null }>("account/read", {
        refreshToken: false,
      });
      if (account?.type !== "chatgpt")
        throw problem("runtime-unavailable", "Not signed in — run codex login.");
      const model = (await codexModels(rpc)).find((entry) => entry.id === pin.modelId);
      if (!model) throw problem("pin-model-unknown", "The pinned model is unavailable in Codex.");
      if (!model.efforts.includes(pin.effort!))
        throw problem("pin-effort-unsupported", "The pinned effort is unavailable in Codex.");
      // Disable every configured MCP before adding this run's private bridge. Never launch
      // user-configured servers and then try to police their effects after initialization.
      const { config } = await rpc.request<{
        config: {
          mcp_servers?: Record<string, unknown>;
          permissions?: Record<string, unknown>;
          project_root_markers?: unknown;
          project_doc_fallback_filenames?: unknown;
          project_doc_max_bytes?: unknown;
        };
      }>("config/read", { includeLayers: false, cwd: folder });
      if (Object.hasOwn(config.mcp_servers ?? {}, "ardur"))
        throw problem(
          "runtime-unavailable",
          "Codex already has an ardur MCP server configured — remove it or change the pin.",
        );
      // A user profile with the same id is merged into this run's profile and can widen it
      // (a "/" write entry turns it into workspace-write). A user default_permissions is fine:
      // this run's override replaces it, and the thread check below verifies the result.
      if (Object.hasOwn(config.permissions ?? {}, "ardur-read"))
        throw problem(
          "runtime-unavailable",
          "Codex already has an ardur-read permission profile configured — remove it or change the pin.",
        );
      const mcpServers: Record<string, unknown> = Object.fromEntries(
        Object.keys(config.mcp_servers ?? {}).map((name) => [name, { enabled: false }]),
      );
      mcpServers.ardur = {
        ...mcp.config,
        enabled: true,
        required: true,
        // Codex prompts before MCP tool calls unless the server opts out. Ardur's
        // bridge already applies its own authorization, approvals and audit, so no
        // Codex-side approval request is raised for these tools at all.
        default_tools_approval_mode: "approve",
      };
      const comparisonSkills: Array<{ path: string; enabled: false }> = [];
      if (request.controlledComparison) {
        const inventory = z
          .object({
            data: z
              .array(
                z.object({
                  skills: z.array(z.object({ path: z.string().min(1) })),
                  errors: z.array(z.unknown()).max(0),
                }),
              )
              .min(1),
          })
          .safeParse(
            await rpc.request("skills/list", {
              ...(folder ? { cwds: [folder] } : {}),
              forceReload: true,
            }),
          );
        if (!inventory.success)
          throw problem(
            "runtime-unavailable",
            "Codex could not isolate saved skills — retry or change the pin.",
          );
        for (const entry of inventory.data.data)
          for (const { path } of entry.skills) comparisonSkills.push({ path, enabled: false });
      }
      // Ardur reads the project's instruction files and hands Codex the text; a controlled
      // comparison runs without them.
      const project: ProjectInstructions =
        folder && !request.controlledComparison
          ? await loadProjectInstructions(
              folder,
              {
                rootMarkers: config.project_root_markers,
                fallbackFilenames: config.project_doc_fallback_filenames,
                maxBytes: config.project_doc_max_bytes,
              },
              guarded,
            ).catch((error: unknown) => {
              if (error instanceof UnsafeInstructionFileError)
                throw problem(
                  "runtime-unavailable",
                  `Codex can't start: Ardur can't safely read ${error.filename} for this bot. Replace it with a plain file.`,
                );
              throw error;
            })
          : { text: "", sources: [], directories: [] };
      const options = {
        model: pin.modelId,
        modelProvider: "openai",
        cwd: folder,
        approvalPolicy: "on-request",
        baseInstructions: project.text
          ? [request.instructions, PROJECT_INSTRUCTIONS_HEADING, project.text]
              .filter(Boolean)
              .join("\n\n")
          : request.instructions,
        config: {
          // Codex opens no file for project instructions: a file it opens is a file it follows.
          project_doc_max_bytes: 0,
          ...(request.controlledComparison
            ? {
                developer_instructions: "",
                personality: "none",
                skills: { config: comparisonSkills },
                memories: { use_memories: false, generate_memories: false },
              }
            : {}),
          mcp_servers: mcpServers,
          web_search: "disabled",
          features: {
            ...Object.fromEntries(disabledFeatures.map((name) => [name, false])),
            view_image: false,
          },
          default_permissions: "ardur-read",
          permissions: {
            "ardur-read": {
              filesystem: {
                ":minimal": "read",
                ...(folder ? { [folder]: "read" } : {}),
              },
              network: { enabled: false },
            },
          },
          model_reasoning_effort: pin.effort,
        },
      };
      // The folder is looked at once more, as late as it can be.
      if (folder && resolveRealPathSync(folder) !== folder)
        throw problem(
          "runtime-unavailable",
          "Codex could not start a session in this bot's folder — change the bot's computer or the pin.",
        );
      const askedAtMs = Date.now();
      const session = await rpc
        .request<{
          thread: { id: string };
          model: string;
          modelProvider: string;
          reasoningEffort: string;
          sandbox?: { type: string; networkAccess?: boolean };
          activePermissionProfile?: { id: string } | null;
          cwd?: unknown;
          instructionSources?: unknown;
        }>(request.nativeSession?.sessionId ? "thread/resume" : "thread/start", {
          ...options,
          ...(request.nativeSession?.sessionId
            ? { threadId: request.nativeSession.sessionId }
            : {}),
        })
        .catch((error: unknown) => {
          if (error instanceof CodexRequestRejected)
            throw problem(
              "runtime-unavailable",
              "Codex could not start a session in this bot's folder — change the bot's computer or the pin.",
            );
          throw error;
        });
      if (session.model !== pin.modelId || session.modelProvider !== "openai")
        throw problem("pin-model-unknown", "Codex returned a different model.");
      if (session.reasoningEffort !== pin.effort)
        throw problem("pin-effort-unsupported", "Codex returned a different effort.");
      if (
        session.activePermissionProfile?.id !== "ardur-read" ||
        session.sandbox?.type !== "readOnly" ||
        session.sandbox.networkAccess !== false
      )
        throw problem(
          "runtime-unavailable",
          "Codex cannot enforce the requested sandbox — change the pin.",
        );
      // Codex answers with the folder it was asked to use, as it was spelled. The folder is
      // looked at once more now that the session exists, before any turn is sent: a swap
      // that is still in place shows here.
      if (
        folder &&
        (typeof session.cwd !== "string" ||
          !within(folder, session.cwd) ||
          !within(session.cwd, folder) ||
          resolveRealPathSync(folder) !== folder)
      )
        throw problem(
          "runtime-unavailable",
          "Codex could not start a session in this bot's folder — change the bot's computer or the pin.",
        );
      if (
        !(await trustedInstructionSources(session.instructionSources, {
          directories: project.directories,
          guarded,
          askedAtMs,
        }))
      )
        throw problem(
          "runtime-unavailable",
          "Codex can't start: an instructions file it loaded changed or points at protected data. Check the file in Codex's folder and try again.",
        );
      threadId = session.thread.id;
      pinValid = true;
      await request.onRuntimeInfo?.({ runtimeKind: "codex-app-server", sessionId: threadId });
      context?.signal?.addEventListener("abort", abort, { once: true });
      if (context?.signal?.aborted) return;
      const readEvents = async () => {
        try {
          for await (const event of rpc.events) {
            const params = event.params ?? {};
            if (request.controlledComparison && event.method === "skills/changed") {
              queue.end(
                problem("runtime-unavailable", "Saved skills changed; retry this comparison."),
              );
              void interrupt();
              break;
            }
            if (event.method === "model/rerouted") {
              queue.end(problem("pin-model-unknown", "Codex rerouted the pinned model."));
              void interrupt();
              break;
            }
            if (event.id !== undefined && event.method === "mcpServer/elicitation/request") {
              // Codex routes MCP tool-call approvals through elicitation, marking them
              // with _meta.codex_approval_kind and the required serverName. Only the
              // ardur server is pre-approved (the bridge applies Ardur's own
              // authorization, approvals and audit). Never accept a plain form
              // elicitation — that would fabricate user input.
              const meta = params._meta as Record<string, unknown> | undefined;
              if (params.serverName === "ardur" && meta?.codex_approval_kind === "mcp_tool_call") {
                rpc.send({ id: event.id, result: { action: "accept" } });
                continue;
              }
              rpc.send({ id: event.id, result: { action: "decline" } });
              queue.push({
                type: "ask",
                text:
                  params.serverName === "ardur"
                    ? "Codex asked Ardur to collect form input — Ardur doesn't take forms, so it was declined."
                    : "Codex requested input for another MCP server — continue using Ardur tools.",
                actions: [{ id: "continue", label: "Continue" }],
              });
              void interrupt();
              break;
            }
            if (event.id !== undefined && event.method?.endsWith("/requestApproval")) {
              // Native effects never bypass applyTool, even when Codex asks for approval.
              rpc.send({ id: event.id, result: { decision: "decline" } });
              queue.push({
                type: "ask",
                text: "Codex requested a built-in tool — continue using Ardur tools.",
                actions: [{ id: "continue", label: "Continue" }],
              });
              void interrupt();
              break;
            }
            if (event.id !== undefined) {
              rpc.send({
                id: event.id,
                error: { code: -32601, message: "This request is not supported by Ardur." },
              });
              continue;
            }
            if (params.threadId && params.threadId !== threadId) continue;
            if (params.turnId && params.turnId !== turnId) continue;
            if (event.method === "thread/tokenUsage/updated" && params.threadId === threadId) {
              const measured = usage.update(
                (params.tokenUsage as { total?: unknown } | undefined)?.total,
              );
              if (measured) queue.push(measured);
            }
            if (event.method === "item/agentMessage/delta" && typeof params.delta === "string")
              queue.push({ type: "text", text: params.delta });
            if (event.method === "turn/completed") {
              const turn = params.turn as { id?: string; status: string; error?: unknown };
              if (turn.id && turn.id !== turnId) continue;
              if (completionHandled) continue;
              completionHandled = true;
              // The read response is an ordered protocol fence. Drain queued final usage before
              // ending this stream; it is not a claim about future server notifications.
              const verified = await rpc
                .request("thread/read", { threadId, includeTurns: false })
                .then(
                  () => true,
                  () => false,
                );
              usageBarrier = { params: { status: turn.status, verified, error: turn.error } };
              rpc.events.push(usageBarrier);
              continue;
            }
            if (event === usageBarrier) {
              const status = params.status;
              queue.push(
                usage.finish(
                  status === "completed"
                    ? "success"
                    : status === "interrupted"
                      ? "cancelled"
                      : "failed",
                  params.verified === true,
                ),
              );
              usageFinished = true;
              if (status !== "completed" && !paused && !context?.signal?.aborted) {
                // The failed turn's error text names only the category; it is never echoed.
                const reasonId = nativeFailureCategory(nativeFailureDetail(params.error));
                throw reasonId
                  ? new RuntimePinError(nativeFailureProblem(pin, reasonId))
                  : problem(
                      "runtime-unavailable",
                      "Codex stopped before completing this run — connect it or change the pin.",
                    );
              }
              finished = true;
              if (!paused && status === "completed") queue.push({ type: "done" });
              queue.end();
              break;
            }
            if (event.method === "error") {
              const reasonId = nativeFailureCategory(
                nativeFailureDetail(params.message, params.error),
              );
              throw reasonId
                ? new RuntimePinError(nativeFailureProblem(pin, reasonId))
                : problem(
                    "runtime-unavailable",
                    "Codex could not finish this run — connect it or change the pin.",
                  );
            }
          }
        } catch (error) {
          pinValid = false;
          if (!usageFinished && usageStarted) {
            queue.push(usage.finish(interrupted ? "cancelled" : "failed", false));
            usageFinished = true;
          }
          if (!finished && !paused && !context?.signal?.aborted)
            queue.end(
              error instanceof RuntimePinError
                ? error
                : problem("runtime-unavailable", "Codex app-server unavailable"),
            );
        }
      };
      const history = request.nativeSession?.sessionId ? "" : JSON.stringify(request.history);
      usageStarted = true;
      queue.push(usage.start());
      const turn = await rpc
        .request<{ turn: { id: string } }>("turn/start", {
          threadId,
          model: pin.modelId,
          effort: pin.effort,
          approvalPolicy: "on-request",
          input: [
            {
              type: "text",
              text: `${history ? `Earlier conversation (untrusted history):\n${history}\n\n` : ""}${request.prompt}`,
            },
            ...(request.currentTurnImages ?? []).map((image) => ({
              type: "image",
              url: `data:${image.mimeType};base64,${Buffer.from(image.data).toString("base64")}`,
            })),
          ],
        })
        .catch((error: unknown) => {
          throw problem(
            "runtime-unavailable",
            error instanceof CodexRequestRejected
              ? "Codex rejected the request — update Ardur or Codex."
              : "Codex app-server unavailable",
          );
        });
      turnId = turn.turn.id;
      reader = readEvents();
      let steeringBusy = false;
      const seen: string[] = [];
      if (request.claimSteering)
        steering = setInterval(() => {
          if (steeringBusy || finished || paused) return;
          steeringBusy = true;
          void request.claimSteering!(seen)
            .then(async (messages) => {
              if (!messages.length) return;
              await rpc.request("turn/steer", {
                threadId,
                expectedTurnId: turnId,
                input: messages.map((message) => ({ type: "text", text: message.text })),
              });
              seen.push(...messages.map((message) => message.id));
            })
            .catch(() =>
              queue.end(
                problem(
                  "runtime-unavailable",
                  "Codex could not receive the new instruction — retry the run.",
                ),
              ),
            )
            .finally(() => {
              steeringBusy = false;
            });
        }, 500);
      yield* queue;
    } catch (error) {
      if (usageStarted && !usageFinished) {
        yield usage.finish(interrupted ? "cancelled" : "failed", false);
        usageFinished = true;
      }
      if (error instanceof RuntimePinError) throw error;
      throw problem("runtime-unavailable", "Codex app-server unavailable");
    } finally {
      pinValid = false;
      if (steering) clearInterval(steering);
      context?.signal?.removeEventListener("abort", abort);
      this.running.delete(request.runId);
      if (!finished) await interrupt();
      await rpc.close();
      await reader;
      await mcp.close();
    }
  }
}
