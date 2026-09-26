import type { KubernetesObject } from "@ardurbot/host-runtime/fleet/kubernetes-spec";

export type { KubernetesObject } from "@ardurbot/host-runtime/fleet/kubernetes-spec";

import { readFile } from "node:fs/promises";
import type { ProcessEvent } from "@ardurbot/adapter-kit";
import type {
  RequestContext,
  ResponseContext,
  V1NetworkPolicy,
  V1PersistentVolumeClaim,
  V1Pod,
} from "@kubernetes/client-node";
import type { CapacityMetric, CapacityNode, CapacityPod } from "./fleet/kubernetes-capacity.js";
import { streamKubernetesExec } from "./kubernetes-exec.js";
import { kubernetesPolicyEnforced } from "./kubernetes-network.js";

export interface KubernetesApi {
  capacity?(): Promise<{ nodes: CapacityNode[]; pods: CapacityPod[]; metrics?: CapacityMetric[] }>;
  namespaces?(): Promise<string[]>;
  supportsEgress?(signal: AbortSignal): Promise<boolean>;
  setEgress?(name: string, enabled: boolean, signal: AbortSignal): Promise<void>;
  read(
    resource: "pods" | "persistentvolumeclaims",
    name: string,
    signal: AbortSignal,
  ): Promise<KubernetesObject | null>;
  create(
    resource: "pods" | "persistentvolumeclaims",
    body: KubernetesObject,
    signal: AbortSignal,
  ): Promise<void>;
  remove(
    resource: "pods" | "persistentvolumeclaims",
    name: string,
    signal: AbortSignal,
  ): Promise<void>;
  exec(
    name: string,
    argv: string[],
    signal: AbortSignal,
    input?: Uint8Array,
  ): AsyncIterable<ProcessEvent>;
}
export type KubeconfigSource = { inline?: string; path?: string };

/** Load only when an owner configures Kubernetes; other computers need no Kubernetes client. */
async function loadConfig(source: KubeconfigSource) {
  const { KubeConfig } = await import("@kubernetes/client-node");
  const config = new KubeConfig();
  try {
    if (source.inline) config.loadFromString(source.inline);
    else if (source.path) config.loadFromFile(source.path);
    else throw new Error();
    // Kubeconfig is data, not authorization to execute credential plugins on the server.
    if (
      config
        .getUsers()
        .some((user: { exec?: unknown; authProvider?: unknown }) => user.exec || user.authProvider)
    )
      throw new Error();
    if (
      config
        .getClusters()
        .some(
          (cluster: { skipTLSVerify?: boolean; server: string }) =>
            cluster.skipTLSVerify || !cluster.server.startsWith("https://"),
        )
    )
      throw new Error();
    return config;
  } catch {
    throw new Error(
      "Use a valid HTTPS kubeconfig with certificate or token authentication and no credential plugins.",
    );
  }
}
export async function kubernetesContexts(
  source: KubeconfigSource,
): Promise<{ name: string; local: boolean }[]> {
  const config = await loadConfig(source);
  return config.getContexts().map((context: { name: string; cluster: string }) => ({
    name: context.name,
    local: context.cluster.startsWith("kind-"),
  }));
}

/** Snapshot file references before encryption so worker hosts need no credential mounts. */
export async function snapshotKubeconfig(source: KubeconfigSource): Promise<KubeconfigSource> {
  const config = await loadConfig(source);
  try {
    const exported = JSON.parse(config.exportConfig()) as {
      clusters: { cluster: Record<string, unknown> }[];
      users: { user: Record<string, unknown> }[];
    };
    for (const { cluster } of exported.clusters) {
      if (typeof cluster["certificate-authority"] === "string") {
        cluster["certificate-authority-data"] = (
          await readFile(cluster["certificate-authority"])
        ).toString("base64");
        delete cluster["certificate-authority"];
      }
    }
    for (const { user } of exported.users) {
      for (const field of ["client-certificate", "client-key"]) {
        if (typeof user[field] === "string") {
          user[`${field}-data`] = (await readFile(user[field] as string)).toString("base64");
          delete user[field];
        }
      }
    }
    const inline = JSON.stringify(exported);
    if (Buffer.byteLength(inline) > 1024 * 1024) throw new Error();
    return { inline };
  } catch {
    throw new Error("Kubeconfig certificate files are unavailable or too large.");
  }
}

export async function createKubernetesApi(
  source: KubeconfigSource,
  namespace: string,
  context: string,
): Promise<KubernetesApi> {
  const { CoreV1Api, AppsV1Api, NetworkingV1Api, CustomObjectsApi, Exec, createConfiguration } =
    await import("@kubernetes/client-node");
  const config = await loadConfig(source);
  if (!config.getContexts().some((entry: { name: string }) => entry.name === context))
    throw new Error("The selected Kubernetes context is unavailable.");
  config.setCurrentContext(context);
  const client = config.makeApiClient(CoreV1Api);
  const apps = config.makeApiClient(AppsV1Api);
  const networking = config.makeApiClient(NetworkingV1Api);
  const custom = config.makeApiClient(CustomObjectsApi);
  const exec = new Exec(config);
  const options = (signal: AbortSignal) => ({
    middlewareMergeStrategy: "append" as const,
    middleware: createConfiguration({
      promiseMiddleware: [
        {
          pre: async (request: RequestContext) => {
            request.setSignal(AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
            return request;
          },
          post: async (response: ResponseContext) => response,
        },
      ],
    }).middleware,
  });
  const statusCode = (error: unknown) => (error as { code?: number })?.code;
  async function apiCall<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      if (statusCode(error) === 404 || statusCode(error) === 409) throw error;
      // Client exceptions include URLs, headers, and bodies. Never propagate those to logs.
      throw new Error("Kubernetes request failed; check the connection and namespace permissions.");
    }
  }
  async function supportsEgress(signal: AbortSignal) {
    try {
      const [controller, settings, policies, namespaced, clusterwide] = await Promise.all([
        apps.readNamespacedDaemonSet({ namespace: "kube-system", name: "cilium" }, options(signal)),
        client.readNamespacedConfigMap(
          { namespace: "kube-system", name: "cilium-config" },
          options(signal),
        ),
        networking.listNamespacedNetworkPolicy({ namespace }, options(signal)),
        custom.listNamespacedCustomObject(
          { group: "cilium.io", version: "v2", plural: "ciliumnetworkpolicies", namespace },
          options(signal),
        ),
        custom.listClusterCustomObject(
          { group: "cilium.io", version: "v2", plural: "ciliumclusterwidenetworkpolicies" },
          options(signal),
        ),
      ]);
      const customCount = (value: unknown) => {
        const items = (value as { items?: unknown[] }).items;
        if (!Array.isArray(items)) throw new Error("Unknown policy response");
        return items.length;
      };
      return kubernetesPolicyEnforced({
        desired: controller.status?.desiredNumberScheduled ?? 0,
        ready: controller.status?.numberReady ?? 0,
        mode: settings.data?.["enable-policy"] ?? "",
        namespaceEgress: policies.items.map((policy) => ({ egress: policy.spec?.egress })),
        customPolicies: customCount(namespaced) + customCount(clusterwide),
      });
    } catch {
      return false;
    }
  }
  return {
    async capacity() {
      const signal = AbortSignal.timeout(8000);
      const [nodes, pods, metrics] = await Promise.all([
        client.listNode({}, options(signal)),
        client.listPodForAllNamespaces({}, options(signal)),
        config
          .makeApiClient(CustomObjectsApi)
          .listClusterCustomObject(
            { group: "metrics.k8s.io", version: "v1beta1", plural: "nodes" },
            options(signal),
          )
          .catch(() => null),
      ]);
      return {
        nodes: nodes.items as CapacityNode[],
        pods: pods.items as CapacityPod[],
        metrics: metrics ? (metrics as { items: CapacityMetric[] }).items : undefined,
      };
    },
    async namespaces() {
      return (await client.listNamespace({}, options(AbortSignal.timeout(8000)))).items.flatMap(
        (item) => (item.metadata?.name ? [item.metadata.name] : []),
      );
    },
    supportsEgress,
    async setEgress(name, enabled, signal) {
      if (enabled && !(await supportsEgress(signal))) return;
      if (!enabled && !(await supportsEgress(signal)))
        throw new Error(
          "Network policy enforcement is unavailable or conflicting egress policies exist.",
        );
      let existing: V1NetworkPolicy | undefined;
      try {
        existing = await networking.readNamespacedNetworkPolicy(
          { namespace, name },
          options(signal),
        );
      } catch (error) {
        if (statusCode(error) !== 404) throw new Error("Network policy lookup failed.");
      }
      if (existing && existing.metadata?.labels?.["ardurbot.com/computer"] !== name)
        throw new Error("Network policy identity does not match.");
      if (enabled) {
        if (existing)
          await apiCall(signal, () =>
            networking.deleteNamespacedNetworkPolicy({ namespace, name }, options(signal)),
          );
        return;
      }
      const body = {
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: { name, labels: { "ardurbot.com/computer": name } },
        spec: {
          podSelector: { matchLabels: { "ardurbot.com/computer": name } },
          policyTypes: ["Egress"],
          egress: [],
        },
      };
      if (existing)
        await apiCall(signal, () =>
          networking.replaceNamespacedNetworkPolicy({ namespace, name, body }, options(signal)),
        );
      else
        await apiCall(signal, () =>
          networking.createNamespacedNetworkPolicy({ namespace, body }, options(signal)),
        );
    },
    async read(resource, name, signal) {
      try {
        return (await apiCall(signal, async () =>
          resource === "pods"
            ? await client.readNamespacedPod({ namespace, name }, options(signal))
            : await client.readNamespacedPersistentVolumeClaim(
                { namespace, name },
                options(signal),
              ),
        )) as KubernetesObject;
      } catch (error) {
        if (statusCode(error) === 404) return null;
        throw new Error("Kubernetes resource lookup failed.");
      }
    },
    async create(resource, body, signal) {
      try {
        await apiCall(signal, async () => {
          if (resource === "pods")
            await client.createNamespacedPod({ namespace, body: body as V1Pod }, options(signal));
          else
            await client.createNamespacedPersistentVolumeClaim(
              { namespace, body: body as V1PersistentVolumeClaim },
              options(signal),
            );
        });
      } catch {
        throw new Error(
          "Kubernetes resource creation failed; check namespace permissions and storage.",
        );
      }
    },
    async remove(resource, name, signal) {
      try {
        await apiCall(signal, async () => {
          if (resource === "pods")
            await client.deleteNamespacedPod({ namespace, name }, options(signal));
          else
            await client.deleteNamespacedPersistentVolumeClaim(
              { namespace, name },
              options(signal),
            );
        });
      } catch (error) {
        if (statusCode(error) !== 404) throw new Error("Kubernetes resource deletion failed.");
      }
    },
    exec(name, argv, signal, input) {
      return streamKubernetesExec(exec, namespace, name, argv, signal, input);
    },
  };
}
