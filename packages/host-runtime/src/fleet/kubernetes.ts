import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext } from "@ardurbot/adapter-kit";
import type { ComputerConnectionSettings, RemoteComputerAction } from "@ardurbot/contracts";
import { kubernetesComputerSpec, kubernetesVolumeSpec } from "./kubernetes-spec.js";
import type { FleetProcess } from "./process.js";
import { streamFleetProcess, systemFleetProcess } from "./process.js";

/** The existing Kubernetes provider owns lifecycle; this transports its API operations from the host. */
export class HostKubernetesConnection {
  constructor(
    private readonly settings: ComputerConnectionSettings,
    private readonly configuration: () => Promise<string>,
    private readonly processes: FleetProcess = systemFleetProcess,
  ) {}
  async call(
    homeKey: string,
    action: RemoteComputerAction,
    context: AdapterContext,
    send: (channel: "result" | "stdout" | "stderr" | "exit", data: unknown) => Promise<void>,
  ) {
    const name = `ardurbot-${createHash("sha256").update(`${context.spaceId}\0${homeKey}`).digest("hex").slice(0, 32)}`;
    const directory = await mkdtemp(path.join(tmpdir(), "ardurbot-kube-"));
    try {
      const file = path.join(directory, "config");
      const config = JSON.parse(await this.configuration()) as {
        clusters?: { cluster: { server?: string; "insecure-skip-tls-verify"?: boolean } }[];
        users?: { user: Record<string, unknown> }[];
      };
      if (
        !config.clusters?.length ||
        config.clusters.some(
          ({ cluster }) =>
            !cluster.server?.startsWith("https://") ||
            cluster["insecure-skip-tls-verify"] ||
            "certificate-authority" in cluster,
        ) ||
        config.users?.some(
          ({ user }) =>
            user.exec ||
            user["auth-provider"] ||
            Object.keys(user).some(
              (key) => key.endsWith("File") || ["client-key", "client-certificate"].includes(key),
            ),
        )
      )
        throw new Error(
          "Use an HTTPS kubeconfig with embedded certificate or token authentication.",
        );
      await writeFile(file, JSON.stringify(config), { mode: 0o600 });
      const prefix = [
        "--kubeconfig",
        file,
        "--context",
        this.settings.context!,
        "--namespace",
        this.settings.namespace,
        "--request-timeout=10s",
      ];
      const run = async (argv: string[], input?: Uint8Array) => {
        const result = await this.processes.run(
          "kubectl",
          [...prefix, ...argv],
          AbortSignal.any([context.signal, AbortSignal.timeout(15000)]),
          input,
          8 * 1024 * 1024,
        );
        if (result.code !== 0)
          throw new Error("Kubernetes request failed; check the context and permissions.");
        return result.stdout.toString().trim();
      };
      const owned = async (resource: string) => {
        const value = await run(["get", resource, name, "--ignore-not-found", "-o", "json"]);
        const object = value
          ? (JSON.parse(value) as { metadata?: { labels?: Record<string, string> } })
          : null;
        if (object && object.metadata?.labels?.["ardurbot.com/computer"] !== name)
          throw new Error("Kubernetes computer identity does not match.");
        return object;
      };
      if ("name" in action && action.name !== name)
        throw new Error("Computer does not belong to this workspace.");
      switch (action.type) {
        case "kube.version":
          return send(
            "result",
            JSON.parse(await run(["version", "--output=json"])).serverVersion?.gitVersion ??
              "Kubernetes",
          );
        case "kube.capacity": {
          const [nodes, pods, metrics] = await Promise.all([
            run(["get", "nodes", "-o", "json"]),
            run(["get", "pods", "--all-namespaces", "-o", "json"]),
            run(["get", "--raw", "/apis/metrics.k8s.io/v1beta1/nodes"]).catch(() => "null"),
          ]);
          return send("result", {
            nodes: JSON.parse(nodes).items,
            pods: JSON.parse(pods).items,
            metrics: JSON.parse(metrics)?.items,
          });
        }
        case "kube.namespaces":
          return send(
            "result",
            JSON.parse(await run(["get", "namespaces", "-o", "json"])).items.map(
              (item: { metadata: { name: string } }) => item.metadata.name,
            ),
          );
        case "kube.read":
          return send("result", await owned(action.resource));
        case "kube.remove":
          if (await owned(action.resource))
            await run(["delete", action.resource, name, "--ignore-not-found", "--wait=false"]);
          return;
        case "kube.create": {
          const body = action.body as {
            kind?: string;
            metadata?: { name?: string; namespace?: string; labels?: Record<string, string> };
            spec?: Record<string, unknown>;
          };
          if (
            body.metadata?.name !== name ||
            body.metadata.labels?.["ardurbot.com/computer"] !== name ||
            (body.metadata.namespace && body.metadata.namespace !== this.settings.namespace)
          )
            throw new Error("Kubernetes computer identity does not match.");
          const canonical = (value: unknown): string => {
            if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
            if (value && typeof value === "object")
              return `{${Object.entries(value)
                .filter(([, item]) => item !== undefined)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
                .join(",")}}`;
            return JSON.stringify(value);
          };
          const normalized = { ...body, metadata: { ...body.metadata } };
          delete normalized.metadata.namespace;
          const expected =
            action.resource === "pods"
              ? [
                  kubernetesComputerSpec(name, "base", this.settings),
                  kubernetesComputerSpec(name, "developer", this.settings),
                ]
              : [kubernetesVolumeSpec(name, this.settings)];
          if (!expected.some((spec) => canonical(spec) === canonical(normalized)))
            throw new Error("Invalid computer resource.");
          if (!(await owned(action.resource)))
            await run(["create", "-f", "-"], Buffer.from(JSON.stringify(body)));
          return;
        }
        case "kube.exec": {
          if (!(await owned("pods"))) throw new Error("Kubernetes computer is unavailable.");
          const child = await this.processes.start("kubectl", [
            ...prefix.filter((option) => !option.startsWith("--request-timeout=")),
            "exec",
            "-i",
            name,
            "--",
            ...action.argv,
          ]);
          for await (const event of streamFleetProcess(
            child,
            context.signal,
            action.input ? Buffer.from(action.input, "base64") : undefined,
          ))
            await send(event.type, event.type === "exit" ? event.code : event.data);
          return;
        }
        default:
          throw new Error("Unsupported Kubernetes operation.");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
