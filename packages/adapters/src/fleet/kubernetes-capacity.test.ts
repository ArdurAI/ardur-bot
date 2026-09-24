import { expect, it } from "vitest";
import { kubernetesCapacity, podRequest, resourceQuantity } from "./kubernetes-capacity.js";

it("subtracts requests and the larger observed use, without pretending CPU usage is load average", () => {
  const nodes = [
    {
      metadata: { name: "node" },
      status: {
        allocatable: { cpu: "8", memory: "16Gi", "ephemeral-storage": "100Gi" },
        conditions: [{ type: "Ready", status: "True" }],
      },
    },
  ];
  const pods = [
    {
      spec: {
        nodeName: "node",
        containers: [{ resources: { requests: { cpu: "500m", memory: "4Gi" } } }],
      },
    },
  ];
  expect(kubernetesCapacity(nodes, pods)).toMatchObject({
    memoryFree: 12 * 1024 ** 3,
    source: "kubernetes-requests",
    cpuLoad1m: null,
  });
  expect(
    kubernetesCapacity(nodes, pods, [{ metadata: { name: "node" }, usage: { memory: "8Gi" } }]),
  ).toMatchObject({ memoryFree: 8 * 1024 ** 3, source: "kubernetes-metrics" });
  expect(kubernetesCapacity([{ ...nodes[0], spec: { unschedulable: true } }], pods).source).toBe(
    "not-reported",
  );
});
it("accounts for init containers, sidecars and overhead", () => {
  const resources = (memory: string) => ({ resources: { requests: { memory } } });
  expect(
    podRequest(
      {
        spec: {
          containers: [resources("1Gi")],
          initContainers: [{ ...resources("1Gi"), restartPolicy: "Always" }, resources("4Gi")],
          overhead: { memory: "1Gi" },
        },
      },
      "memory",
    ),
  ).toBe(6 * 1024 ** 3);
  expect(resourceQuantity("500m")).toBe(0.5);
  expect(resourceQuantity("1e3")).toBe(1000);
});
