import { AsyncLocalStorage } from "node:async_hooks";
import type {
  AdapterContext,
  AgentRuntime,
  ConnectorCall,
  ConnectorEvent,
} from "@ardurbot/adapter-kit";
import { contentDigest } from "../../scoreboard/manifest.js";
import { DepartmentServices } from "../../scoreboard/replay/services.js";
import type { Emit } from "../adapters/types.js";
import type { BudgetLedger } from "../budget.js";
import { requireValue } from "../budget.js";

interface Intent {
  name: string;
  executionId: string;
  digest: string;
}
/** One admission authority for native tools and helpers. No effect is authorized by stdout. */
export class TrialAdmission {
  private readonly scope = new AsyncLocalStorage<Intent>();
  private readonly installed = new WeakSet<AgentRuntime>();
  private route: { baseUrl: string; modelId: string } | null = null;
  constructor(
    readonly trialId: string,
    readonly ledger: BudgetLedger,
    readonly emit: Emit,
    readonly allowedTools: readonly string[],
  ) {}
  current() {
    return this.scope.getStore();
  }
  bindModel(baseUrl: string, modelId: string) {
    requireValue(!this.route, "Model route already frozen");
    const url = new URL(baseUrl);
    requireValue(
      url.protocol === "http:" &&
        url.hostname === "127.0.0.1" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        /^\/c\/cap_[a-f0-9]{48}\/v1$/.test(url.pathname),
      "Expected disposable gateway capability",
    );
    this.route = Object.freeze({ baseUrl, modelId });
  }
  requireEffect(tool: string) {
    const current = this.current();
    requireValue(
      current && (current.name === tool || current.name === "mcp_execute_tool"),
      "Effect lacks pre-effect admission",
    );
    return current;
  }
  descendant(name: string) {
    this.ledger.charge(this.trialId, "descendants");
    this.emit("diagnostic", "effect-broker", {
      boundary: "descendant-admission",
      name,
      productPrevention: false,
    });
  }
  install(runtime: AgentRuntime) {
    requireValue(!this.installed.has(runtime), "Runtime admission already installed");
    this.installed.add(runtime);
    const run = runtime.run.bind(runtime);
    const owner = this;
    runtime.run = async function* (request, context) {
      requireValue(
        owner.route &&
          request.model.baseUrl === owner.route.baseUrl &&
          request.model.id === owner.route.modelId,
        "Runtime model route drift",
      );
      const permits = new Map<string, number>();
      const consume = (name: string, args: unknown, executionId: string) => {
        const count = permits.get(name) ?? 0;
        requireValue(count > 0, "Tool skipped pre-effect admission");
        permits.set(name, count - 1);
        const digest = contentDigest({ trialId: owner.trialId, name, args, executionId });
        owner.emit("tool-intent", "effect-broker", {
          tool: name,
          executionId,
          intentHash: digest,
          preEffectBudgetAdmission: true,
          productPrevention: false,
        });
        return { name, executionId, digest };
      };
      const admittedHelpers = new Set<string>();
      yield* run(
        {
          ...request,
          authorizeTool: async (name) => {
            owner.ledger.charge(owner.trialId, "toolCalls");
            requireValue(
              owner.allowedTools.some(
                (tool) => name === tool || name === `mcp__scoreboard__${tool}`,
              ),
              "Controlled lane denied undeclared tool",
            );
            const authorization = await request.authorizeTool?.(name);
            if (!authorization) permits.set(name, (permits.get(name) ?? 0) + 1);
            return authorization;
          },
          executeTool: async (name, args, executionId, route) => {
            const intent = consume(name, args, executionId);
            requireValue(request.executeTool, "Missing production tool boundary");
            return owner.scope.run(intent, () =>
              request.executeTool!(name, args, executionId, route),
            );
          },
          admitHelper: async (executionId, name, task, card) => {
            const intent = consume("run_subagent", { name, task, card: card ?? null }, executionId);
            owner.descendant("run_subagent");
            requireValue(request.admitHelper, "Missing production helper boundary");
            // Workspace preparation is a confinement-compatible effect, not a second descendant.
            const result = await owner.scope.run({ ...intent, name: "workspace-prepare" }, () =>
              request.admitHelper!(executionId, name, task, card),
            );
            if ("id" in result) admittedHelpers.add(result.id);
            return result;
          },
          executeHelperTool: async (id, name, args, executionId, route) => {
            requireValue(
              admittedHelpers.has(id) && request.executeHelperTool,
              "Helper lacks descendant admission",
            );
            const intent = consume(name, args, executionId);
            return owner.scope.run(intent, () =>
              request.executeHelperTool!(id, name, args, executionId, route),
            );
          },
          resolveModel: async (provider, modelId) => {
            requireValue(
              provider === request.model.provider && modelId === request.model.id,
              "Helper model route drift",
            );
            return request.model;
          },
        },
        context,
      );
    };
  }
}

export class AdmittedDepartmentServices extends DepartmentServices {
  constructor(private readonly admission: TrialAdmission) {
    super();
  }
  override async *execute(
    call: ConnectorCall,
    context: AdapterContext,
  ): AsyncIterable<ConnectorEvent> {
    this.admission.requireEffect(call.tool);
    yield* super.execute(call, context);
  }
}
