import path from "node:path";
import { performance } from "node:perf_hooks";
import { contentDigest } from "../../scoreboard/manifest.js";
import { startBroker, TrialBroker } from "../broker.js";
import type { BudgetLedger } from "../budget.js";
import { requireValue } from "../budget.js";
import { COMPUTER_IMAGE, HERMES_CONTAINER_REVISION, HERMES_IMAGE } from "../containers/policy.js";
import { ContainerSession, inspectImage } from "../containers/session.js";
import { assertOwnedTrial } from "../isolation.js";
import { sanitize } from "../provenance.js";
import { hermesArguments, superviseHermesProcess, syntheticHermesConfig } from "./hermes.js";
import type { TrialArtifacts, TrialContext, VersusAdapter } from "./types.js";

/** Cancel and loss probes use this sentence when the guest workspace was not read. */
export const WORKSPACE_NOT_INSPECTED = "The workspace could not be inspected.";

/** File contents stay in `files`. Symlink paths stay in `links` and are never followed. */
export function guestWorkspace(entries: Record<string, string | { kind: "link" }>) {
  const files: Record<string, string> = {};
  const links: string[] = [];
  for (const [name, entry] of Object.entries(entries)) {
    if (typeof entry === "string") files[name] = entry;
    else if (entry.kind === "link") links.push(name);
    else throw new Error("Unexpected guest snapshot entry");
  }
  return { files, links };
}

export class HermesContainerAdapter implements VersusAdapter {
  readonly product = "hermes" as const;
  readonly cohort: "hermes-release-linux-arm64" | "hermes-scripted-container-standin";
  session: ContainerSession | null = null;
  broker: TrialBroker | null = null;
  private mcp: Awaited<ReturnType<typeof startBroker>> | null = null;
  private context: TrialContext | null = null;
  private route: { providerUrl: string; brokerUrl: string } | null = null;
  private result: Awaited<ReturnType<typeof superviseHermesProcess>> | null = null;
  private operation: Promise<void> | null = null;
  private control = new AbortController();
  private elapsedMs = 0;
  private snapshot:
    | (Awaited<ReturnType<TrialBroker["snapshot"]>> & { snapshot?: { error: string } })
    | (Awaited<ReturnType<TrialBroker["snapshotReceipts"]>> & {
        snapshot: { error: string };
      })
    | null = null;
  constructor(
    private readonly options: {
      ledger: BudgetLedger;
      /** Explicit test double source; this cannot be labeled as the release cohort. */
      standin?: string;
      observedRoute?: () => { endpoint: string; model: string; digest: string } | null;
    },
  ) {
    this.cohort =
      options.standin === undefined
        ? "hermes-release-linux-arm64"
        : "hermes-scripted-container-standin";
  }
  async inspect() {
    const image = await inspectImage(
      this.options.standin === undefined ? HERMES_IMAGE : COMPUTER_IMAGE,
    );
    if (this.options.standin === undefined)
      requireValue(
        image.revision === HERMES_CONTAINER_REVISION,
        "Hermes image source revision drift",
      );
    return {
      cohort: this.cohort,
      image: this.options.standin === undefined ? HERMES_IMAGE : COMPUTER_IMAGE,
      imageId: image.id,
      sourceRevision: this.options.standin === undefined ? image.revision : null,
      scripted: this.options.standin !== undefined,
    };
  }
  async prepare(context: TrialContext) {
    requireValue(!this.context, "Container adapter already prepared");
    await assertOwnedTrial(context.workspace, context.stateDirectory);
    await this.inspect(); // Missing image refuses before container or provider startup.
    this.context = context;
    try {
      const session = await ContainerSession.open({
        root: context.stateDirectory,
        image: this.options.standin === undefined ? HERMES_IMAGE : COMPUTER_IMAGE,
        budget: context.budget,
        wallMs: Math.floor(this.options.ledger.remainingMs(context.id)),
      });
      this.session = session;
      this.broker = new TrialBroker({
        trialId: context.id,
        workspace: context.workspace,
        journal: path.join(context.stateDirectory, "broker-receipts.jsonl"),
        task: context.task,
        ledger: this.options.ledger,
        emit: context.emit,
        files: {
          write: (name, content) => session.write(`workspace/${name}`, content),
          read: async (name) => (await session.read(`workspace/${name}`)).toString("utf8"),
          snapshot: async () => guestWorkspace(await session.snapshot()),
        },
      });
      await this.broker.prepare();
      this.mcp = await startBroker(this.broker);
      this.route = session.bindRelay(context.providerUrl, this.mcp.url);
      const config = syntheticHermesConfig(
        context.budget,
        this.route.providerUrl,
        this.route.brokerUrl,
      );
      await session.write("state/config.yaml", JSON.stringify(config));
      await session.write(
        "state/query.txt",
        `${context.task.prompt}\nInput files: ${Object.keys(context.task.files).join(", ")}.`,
      );
      if (this.options.standin !== undefined)
        await session.write("state/standin.py", this.options.standin);
      context.emit("diagnostic", "product-process", {
        cohort: this.cohort,
        policy: session.policy,
        proof: session.proof,
        configHash: contentDigest(sanitize(JSON.stringify(config))),
        isolatedState: true,
      });
    } catch (error) {
      await this.destroy();
      throw error;
    }
  }
  async submit() {
    requireValue(this.context && this.session && !this.operation, "Container trial not ready");
    this.operation = this.run();
    await this.operation;
  }
  private async run() {
    const context = this.context!,
      session = this.session!;
    const start = performance.now();
    const cancel = () => {
      void this.cancel();
    };
    context.signal.addEventListener("abort", cancel, { once: true });
    try {
      context.signal.throwIfAborted();
      this.control.signal.throwIfAborted();
      const args = hermesArguments({
        queryFile: "/opt/data/state/query.txt",
        workspace: "/opt/data/workspace",
        modelId: context.budget.model.id,
        wallMs: Math.min(context.task.deadlineMs, this.options.ledger.remainingMs(context.id)),
      });
      const argv =
        this.options.standin === undefined
          ? ["/opt/hermes/.venv/bin/hermes", ...args]
          : ["/usr/bin/python3", "-I", "-S", "/opt/data/state/standin.py", ...args];
      context.emit("diagnostic", "product-process", {
        command: argv,
        commandHash: contentDigest(argv),
        cohort: this.cohort,
      });
      const child = await session.exec(argv, {
        env: { OPENAI_BASE_URL: this.route!.providerUrl, OPENAI_API_KEY: "local" },
      });
      this.result = await superviseHermesProcess(child, {
        emit: context.emit,
        signal: this.control.signal,
        timeoutMs: Math.min(context.task.deadlineMs, this.options.ledger.remainingMs(context.id)),
      });
    } catch (error) {
      this.result = {
        terminal: this.control.signal.aborted || context.signal.aborted ? "cancelled" : "uncertain",
        reason: "container-lost",
        reply: null,
        sessionId: null,
      };
      context.emit("diagnostic", "product-process", {
        failure: sanitize(error instanceof Error ? error.message : String(error)),
      });
    } finally {
      this.elapsedMs = performance.now() - start;
      context.revokeProvider();
      context.signal.removeEventListener("abort", cancel);
      this.snapshot = await this.broker!.snapshot().catch(async () => {
        context.emit("diagnostic", "effect-broker", {
          artifactCollection: "guest-files-unavailable",
          receiptsRetained: true,
        });
        try {
          return {
            ...(await this.broker!.snapshotReceipts()),
            snapshot: { error: WORKSPACE_NOT_INSPECTED },
          };
        } catch {
          return {
            state: [],
            effects: [],
            tools: [],
            snapshot: { error: WORKSPACE_NOT_INSPECTED },
          };
        }
      });
      // Killing a docker client alone cannot cancel its guest process. Destroy the owned namespace.
      await session.destroy();
      context.emit("terminal", "product-process", {
        terminal: this.result?.terminal ?? "uncertain",
        reason: this.result?.reason ?? "container-lost",
        durableAdmission: "not-observed",
        cohort: this.cohort,
      });
    }
  }
  async resume(_sessionId: string): Promise<never> {
    throw new Error("Longitudinal container cohort is not selected");
  }
  async cancel() {
    this.control.abort();
    this.context?.revokeProvider();
    await this.session?.destroy();
  }
  async collect(): Promise<TrialArtifacts> {
    requireValue(this.context && this.operation, "No submitted container trial");
    await this.operation.catch(() => undefined);
    const snapshot = this.snapshot ?? { files: {}, links: [], state: [], effects: [], tools: [] };
    const files = "files" in snapshot ? snapshot.files : undefined;
    let result: unknown = null;
    try {
      result = JSON.parse(files?.["result.json"] ?? "null");
    } catch {
      /* Retain invalid artifacts. */
    }
    return {
      observation: {
        ...snapshot,
        result,
        reply: this.result?.reply ?? "",
        expectedPin: {
          endpoint: this.context.budget.endpoint.origin,
          model: this.context.budget.model.id,
          digest: this.context.budget.model.digest,
        },
        observedPin: this.options.observedRoute?.() ?? null,
        elapsedMs: this.elapsedMs,
        terminal: this.result?.terminal ?? "uncertain",
      },
      outcomeReason: this.result?.reason ?? "container-lost",
      sessionId: this.result?.sessionId ?? null,
      userTtft: null,
      userTtftMissingReason: "CLI render/PTY paint remains unqualified",
    };
  }
  async destroy() {
    await this.cancel();
    await this.operation?.catch(() => undefined);
    await this.mcp?.close();
  }
}
