import type { CapacitySnapshot } from "@ardurbot/contracts";
import { unknownCapacity } from "@ardurbot/contracts";

type Resources = Record<string, string | undefined>;
type Container = { resources?: { requests?: Resources }; restartPolicy?: string };
export type CapacityNode = {
  metadata?: { name?: string };
  spec?: { unschedulable?: boolean; taints?: { effect?: string }[] };
  status?: { allocatable?: Resources; conditions?: { type?: string; status?: string }[] };
};
export type CapacityPod = {
  spec?: {
    nodeName?: string;
    containers?: Container[];
    initContainers?: Container[];
    overhead?: Resources;
    resources?: { requests?: Resources };
  };
  status?: { phase?: string };
};
export type CapacityMetric = { metadata?: { name?: string }; usage?: Resources };
export function resourceQuantity(value: string | undefined) {
  if (!value) return 0;
  const match = value.match(/^(\d+(?:\.\d+)?)([eE][+-]?\d+|[numkKMGTPE]i?)?$/);
  if (!match) throw new Error("Invalid Kubernetes quantity.");
  const suffix = match[2] ?? "";
  const scales: Record<string, number> = {
    n: 1e-9,
    u: 1e-6,
    m: 1e-3,
    k: 1e3,
    K: 1e3,
    M: 1e6,
    G: 1e9,
    T: 1e12,
    P: 1e15,
    E: 1e18,
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    Pi: 1024 ** 5,
    Ei: 1024 ** 6,
  };
  const number =
    Number(match[1]) *
    (suffix.startsWith("e") || /^E[+-]?\d/.test(suffix)
      ? 10 ** Number(suffix.slice(1))
      : (scales[suffix] ?? 1));
  if (!Number.isFinite(number)) throw new Error("Invalid Kubernetes quantity.");
  return number;
}
export function podRequest(pod: CapacityPod, resource: string) {
  const spec = pod.spec;
  if (!spec) return 0;
  const amount = (container: Container) =>
    resourceQuantity(container.resources?.requests?.[resource]);
  let sidecars = 0,
    init = 0;
  for (const container of spec.initContainers ?? []) {
    if (container.restartPolicy === "Always") sidecars += amount(container);
    init = Math.max(
      init,
      sidecars + (container.restartPolicy === "Always" ? 0 : amount(container)),
    );
  }
  const regular =
    (spec.containers ?? []).reduce((sum, container) => sum + amount(container), 0) + sidecars;
  return (
    Math.max(resourceQuantity(spec.resources?.requests?.[resource]), regular, init) +
    resourceQuantity(spec.overhead?.[resource])
  );
}
export function kubernetesCapacity(
  nodes: CapacityNode[],
  pods: CapacityPod[],
  metrics?: CapacityMetric[],
): CapacitySnapshot {
  const eligible = nodes.filter(
    (node) =>
      !node.spec?.unschedulable &&
      !node.spec?.taints?.some((taint) =>
        ["NoSchedule", "NoExecute"].includes(taint.effect ?? ""),
      ) &&
      node.status?.conditions?.some(
        (condition) => condition.type === "Ready" && condition.status === "True",
      ),
  );
  if (!eligible.length) return unknownCapacity();
  let cpuCount = 0,
    memoryTotal = 0,
    memoryFree = 0,
    diskFree = 0;
  let measured = true;
  for (const node of eligible) {
    const assigned = pods.filter(
      (pod) =>
        pod.spec?.nodeName === node.metadata?.name &&
        !["Succeeded", "Failed"].includes(pod.status?.phase ?? ""),
    );
    const allocatable = node.status?.allocatable;
    const total = resourceQuantity(allocatable?.memory);
    const reserved = assigned.reduce((sum, pod) => sum + podRequest(pod, "memory"), 0);
    const metric = metrics?.find((metric) => metric.metadata?.name === node.metadata?.name);
    measured &&= !!metric?.usage?.memory;
    cpuCount += resourceQuantity(allocatable?.cpu);
    memoryTotal += total;
    memoryFree += Math.max(0, total - Math.max(reserved, resourceQuantity(metric?.usage?.memory)));
    diskFree += Math.max(
      0,
      resourceQuantity(allocatable?.["ephemeral-storage"]) -
        assigned.reduce((sum, pod) => sum + podRequest(pod, "ephemeral-storage"), 0),
    );
  }
  return {
    cpuCount,
    cpuLoad1m: null,
    memoryTotal,
    memoryFree,
    diskFree,
    sampledAt: new Date().toISOString(),
    source: measured ? "kubernetes-metrics" : "kubernetes-requests",
  };
}
