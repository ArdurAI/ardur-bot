import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Writable } from "node:stream";
import type { AdapterContext } from "@ardurbot/adapter-kit";
import type { RemoteComputerCall } from "@ardurbot/contracts";
import { ComputerConnectionSettingsSchema } from "@ardurbot/contracts";
import { HostKubernetesConnection } from "@ardurbot/host-runtime/fleet/kubernetes";
import type { KubernetesAccess } from "@ardurbot/host-runtime/fleet/kubernetes-access";
import { KUBERNETES_ACCESS } from "@ardurbot/host-runtime/fleet/kubernetes-access";
import {
  kubernetesComputerSpec,
  kubernetesVolumeSpec,
} from "@ardurbot/host-runtime/fleet/kubernetes-spec";
import type { FleetProcess } from "@ardurbot/host-runtime/fleet/process";
import type * as ClientNode from "@kubernetes/client-node";
import type {
  V1ClusterRole,
  V1ClusterRoleBinding,
  V1PolicyRule,
  V1Role,
  V1RoleBinding,
  V1ServiceAccount,
} from "@kubernetes/client-node";
import { loadAllYaml } from "@kubernetes/client-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostKubernetesSandboxProvider } from "./fleet/remote-kubernetes.js";
import { createKubernetesApi } from "./kubernetes-client.js";
import { KubernetesSandboxProvider, kubernetesComputerName } from "./kubernetes-sandbox.js";
import { FakeKubernetesApi } from "./kubernetes-test-api.js";

type Grant = Pick<KubernetesAccess, "verb" | "group" | "resource" | "subresource" | "scope">;
const key = (grant: Grant) =>
  [grant.verb, grant.group || "core", grant.resource, grant.subresource, grant.scope]
    .filter(Boolean)
    .join(" ");
const accessFor = (purpose: KubernetesAccess["purpose"]) =>
  KUBERNETES_ACCESS.filter((access) => access.purpose === purpose);
const manifests = <T>(file: string) =>
  loadAllYaml(readFileSync(`infra/sandboxes/kubernetes/${file}`, "utf8")) as T[];
const pairs = (rules: V1PolicyRule[]) =>
  rules.flatMap((rule) =>
    (rule.apiGroups ?? []).flatMap((group) =>
      (rule.resources ?? []).flatMap((resource) =>
        rule.verbs.map((verb) => `${verb} ${group || "core"} ${resource}`),
      ),
    ),
  );
const pair = (grant: Grant) =>
  `${grant.verb} ${grant.group || "core"} ${grant.subresource ? `${grant.resource}/${grant.subresource}` : grant.resource}`;

const context: AdapterContext = {
  operationId: "access",
  traceId: "access",
  spaceId: "space",
  userId: "owner",
  signal: new AbortController().signal,
};
const settings = ComputerConnectionSettingsSchema.parse({
  engine: "kubernetes",
  context: "fixture",
  namespace: "computers",
});

// Records every call the direct transport makes through the official client.
const direct = vi.hoisted(() => ({
  calls: [] as string[],
  objects: new Map<string, unknown>(),
  cilium: false,
}));
vi.mock("@kubernetes/client-node", async (importOriginal) => {
  const actual = await importOriginal<typeof ClientNode>();
  const { calls, objects } = direct;
  const status = (code: number) => Object.assign(new Error(`status ${code}`), { code });
  const read = (id: string) => {
    if (!objects.has(id)) throw status(404);
    return objects.get(id);
  };
  const ready = { phase: "Running", conditions: [{ type: "Ready", status: "True" }] };
  type Named = { name: string; body: { metadata: { name: string } } };
  const resource = (plural: string, kind: string, running = false) => ({
    [`readNamespaced${kind}`]: async ({ name }: Named) => {
      calls.push(`readNamespaced${kind}`);
      return read(`${plural}/${name}`);
    },
    [`createNamespaced${kind}`]: async ({ body }: Named) => {
      calls.push(`createNamespaced${kind}`);
      objects.set(`${plural}/${body.metadata.name}`, running ? { ...body, status: ready } : body);
      return body;
    },
    [`replaceNamespaced${kind}`]: async ({ name, body }: Named) => {
      calls.push(`replaceNamespaced${kind}`);
      objects.set(`${plural}/${name}`, body);
      return body;
    },
    [`deleteNamespaced${kind}`]: async ({ name }: Named) => {
      calls.push(`deleteNamespaced${kind}`);
      objects.delete(`${plural}/${name}`);
      return {};
    },
  });
  const list = (method: string, items: unknown[] = []) => ({
    [method]: async () => {
      calls.push(method);
      return { items };
    },
  });
  const cilium = (method: string, result: unknown) => ({
    [method]: async () => {
      calls.push(method);
      if (!direct.cilium) throw status(403);
      return result;
    },
  });
  const client = (methods: object) =>
    class {
      constructor() {
        Object.assign(this, methods);
      }
    };
  return {
    ...actual,
    CoreV1Api: client({
      ...resource("pods", "Pod", true),
      ...resource("persistentvolumeclaims", "PersistentVolumeClaim"),
      ...list("listNode"),
      ...list("listPodForAllNamespaces"),
      ...list("listNamespace", [{ metadata: { name: "computers" } }]),
      ...cilium("readNamespacedConfigMap", { data: { "enable-policy": "default" } }),
    }),
    AppsV1Api: client(
      cilium("readNamespacedDaemonSet", { status: { desiredNumberScheduled: 1, numberReady: 1 } }),
    ),
    NetworkingV1Api: client({
      ...resource("networkpolicies", "NetworkPolicy"),
      ...list("listNamespacedNetworkPolicy"),
    }),
    CustomObjectsApi: client({
      listNamespacedCustomObject: async ({ group, plural }: { group: string; plural: string }) => {
        calls.push(`listNamespacedCustomObject ${group}/${plural}`);
        return { items: [] };
      },
      listClusterCustomObject: async ({ group, plural }: { group: string; plural: string }) => {
        calls.push(`listClusterCustomObject ${group}/${plural}`);
        return { items: [] };
      },
    }),
    VersionApi: client({
      getCode: async () => {
        calls.push("getCode");
        return { gitVersion: "v1.31.2" };
      },
    }),
    Exec: client({
      exec: async (...args: unknown[]) => {
        calls.push("exec");
        const [stdout, , , , done] = args.slice(4) as [
          Writable,
          Writable,
          unknown,
          boolean,
          (status: { status: string }) => void,
        ];
        setTimeout(() => {
          stdout.write("done");
          done({ status: "Success" });
        }, 0);
        return { protocol: "v5.channel.k8s.io", close() {}, on() {} };
      },
    }),
  };
});

afterEach(() => {
  direct.calls.length = 0;
  direct.objects.clear();
  direct.cilium = false;
});

describe("Kubernetes permissions", () => {
  it("role.yaml grants every permission a computer needs, and nothing else", () => {
    const [role] = manifests<V1Role>("role.yaml");
    expect(role?.kind).toBe("Role");
    const computers = accessFor("computers");
    expect(computers.every((access) => access.scope === undefined)).toBe(true);
    expect(new Set(pairs(role!.rules ?? []))).toEqual(new Set(computers.map(pair)));
  });

  it("the optional ClusterRole grants only the capacity reads, bound to the same account", () => {
    const [role, binding] = manifests<V1ClusterRole | V1ClusterRoleBinding>(
      "capacity-clusterrole.yaml",
    ) as [V1ClusterRole, V1ClusterRoleBinding];
    expect(role.kind).toBe("ClusterRole");
    expect(new Set(pairs(role.rules ?? []))).toEqual(new Set(accessFor("capacity").map(pair)));
    expect(binding.roleRef).toEqual({
      apiGroup: "rbac.authorization.k8s.io",
      kind: "ClusterRole",
      name: role.metadata?.name,
    });
    const [account] = manifests<V1ServiceAccount>("serviceaccount.yaml");
    expect(binding.subjects).toEqual([
      {
        kind: "ServiceAccount",
        name: account?.metadata?.name,
        namespace: account?.metadata?.namespace,
      },
    ]);
  });

  it("binds the Role to a ServiceAccount whose token is never mounted", () => {
    const [account] = manifests<V1ServiceAccount>("serviceaccount.yaml");
    const [binding] = manifests<V1RoleBinding>("rolebinding.yaml");
    const [role] = manifests<V1Role>("role.yaml");
    expect(account?.automountServiceAccountToken).toBe(false);
    expect(binding?.roleRef).toEqual({
      apiGroup: "rbac.authorization.k8s.io",
      kind: "Role",
      name: role?.metadata?.name,
    });
    expect(binding?.subjects).toEqual([
      {
        kind: "ServiceAccount",
        name: account?.metadata?.name,
        namespace: account?.metadata?.namespace,
      },
    ]);
    expect(new Set([account, binding, role].map((object) => object?.metadata?.namespace))).toEqual(
      new Set(["ardurbot"]),
    );
  });

  it("make-kubeconfig.sh checks every permission a computer needs and each capacity read", () => {
    const script = readFileSync("infra/sandboxes/kubernetes/make-kubeconfig.sh", "utf8");
    const list = (name: string) =>
      [
        ...(script.match(new RegExp(`readonly ${name}=\\(([^)]*)\\)`))?.[1] ?? "").matchAll(
          /"([^"]+)"/g,
        ),
      ].map((match) => {
        const [scope, verb, name, subresource] = match[1]!.split(" ");
        const [resource, ...group] = name!.split(".");
        return key({
          verb: verb as Grant["verb"],
          group: group.join("."),
          resource: resource!,
          subresource,
          scope: scope === "namespace" ? undefined : "cluster",
        });
      });
    expect(new Set(list("REQUIRED"))).toEqual(new Set(accessFor("computers").map(key)));
    expect(new Set(list("CAPACITY"))).toEqual(new Set(accessFor("capacity").map(key)));
  });

  it("the host transport asks only for the listed permissions", async () => {
    const seen = new Set<string>();
    const objects = new Map<string, string>();
    const withoutConnection = (argv: string[]) =>
      argv.filter(
        (arg, index) =>
          !arg.startsWith("--request-timeout=") &&
          !["--kubeconfig", "--context", "--namespace"].includes(arg) &&
          !["--kubeconfig", "--context", "--namespace"].includes(argv[index - 1] ?? ""),
      );
    const grants = (args: string[], input?: Uint8Array): Grant[] => {
      const [command, first, second] = args;
      if (command === "version") return []; // Any authenticated account may read /version.
      if (command === "exec")
        return [
          { verb: "get", group: "", resource: "pods" },
          { verb: "get", group: "", resource: "pods", subresource: "exec" },
          { verb: "create", group: "", resource: "pods", subresource: "exec" },
        ];
      if (command === "create") {
        const kind = JSON.parse(Buffer.from(input!).toString()).kind;
        return [
          {
            verb: "create",
            group: "",
            resource: kind === "Pod" ? "pods" : "persistentvolumeclaims",
          },
        ];
      }
      if (command === "delete") return [{ verb: "delete", group: "", resource: first! }];
      if (command === "get" && first === "--raw" && second === "/apis/metrics.k8s.io/v1beta1/nodes")
        return [{ verb: "list", group: "metrics.k8s.io", resource: "nodes", scope: "cluster" }];
      if (command === "get" && (args.includes("--all-namespaces") || !second?.startsWith("ardur")))
        return [{ verb: "list", group: "", resource: first!, scope: "cluster" }];
      if (command === "get") return [{ verb: "get", group: "", resource: first! }];
      throw new Error(`Unmapped kubectl call: ${args.join(" ")}`);
    };
    const processes: FleetProcess = {
      async run(_name, argv, _signal, input) {
        const args = withoutConnection(argv);
        for (const grant of grants(args, input)) seen.add(key(grant));
        const [command, first, second] = args;
        let stdout = "";
        if (command === "version") stdout = '{"serverVersion":{"gitVersion":"v1.31.2"}}';
        else if (command === "create") {
          const body = JSON.parse(Buffer.from(input!).toString());
          const plural = body.kind === "Pod" ? "pods" : "persistentvolumeclaims";
          objects.set(`${plural}/${body.metadata.name}`, JSON.stringify(body));
        } else if (command === "delete") objects.delete(`${first}/${second}`);
        else if (command === "get" && second?.startsWith("ardur"))
          stdout = objects.get(`${first}/${second}`) ?? "";
        else if (command === "get")
          stdout = JSON.stringify({
            items: first === "namespaces" ? [{ metadata: { name: "computers" } }] : [],
          });
        return { code: 0, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) };
      },
      async start(_name, argv) {
        for (const grant of grants(withoutConnection(argv))) seen.add(key(grant));
        return spawn("sh", ["-c", "printf done"], { stdio: "pipe" });
      },
    };
    const configuration = JSON.stringify({
      clusters: [{ cluster: { server: "https://kubernetes.example.test" } }],
      users: [{ user: { token: "fixture-token" } }],
    });
    const host = new HostKubernetesConnection(settings, async () => configuration, processes);
    const name = kubernetesComputerName("space", "home");
    const call = (action: RemoteComputerCall["action"]) =>
      host.call("home", action, context, vi.fn());
    for (const type of ["kube.version", "kube.capacity", "kube.namespaces"] as const)
      await call({ type });
    await call({
      type: "kube.create",
      resource: "persistentvolumeclaims",
      body: kubernetesVolumeSpec(name, settings),
    });
    await call({
      type: "kube.create",
      resource: "pods",
      body: kubernetesComputerSpec(name, "base", settings),
    });
    await call({ type: "kube.read", resource: "pods", name });
    await call({ type: "kube.exec", name, argv: ["true"] });
    await call({ type: "kube.remove", resource: "pods", name });
    await call({ type: "kube.remove", resource: "persistentvolumeclaims", name });
    const listed = KUBERNETES_ACCESS.filter((access) => access.transports.includes("host"));
    expect(seen).toEqual(new Set(listed.map(key)));
  });

  it("the direct transport asks only for the listed permissions", async () => {
    const grants: Record<string, Grant[]> = {
      getCode: [], // Any authenticated account may read /version.
      exec: [
        { verb: "get", group: "", resource: "pods", subresource: "exec" },
        { verb: "create", group: "", resource: "pods", subresource: "exec" },
      ],
      listNode: [{ verb: "list", group: "", resource: "nodes", scope: "cluster" }],
      listPodForAllNamespaces: [{ verb: "list", group: "", resource: "pods", scope: "cluster" }],
      "listClusterCustomObject metrics.k8s.io/nodes": [
        { verb: "list", group: "metrics.k8s.io", resource: "nodes", scope: "cluster" },
      ],
      listNamespace: [{ verb: "list", group: "", resource: "namespaces", scope: "cluster" }],
      readNamespacedDaemonSet: [
        { verb: "get", group: "apps", resource: "daemonsets", scope: "kube-system" },
      ],
      readNamespacedConfigMap: [
        { verb: "get", group: "", resource: "configmaps", scope: "kube-system" },
      ],
      listNamespacedNetworkPolicy: [
        { verb: "list", group: "networking.k8s.io", resource: "networkpolicies" },
      ],
      "listNamespacedCustomObject cilium.io/ciliumnetworkpolicies": [
        { verb: "list", group: "cilium.io", resource: "ciliumnetworkpolicies" },
      ],
      "listClusterCustomObject cilium.io/ciliumclusterwidenetworkpolicies": [
        {
          verb: "list",
          group: "cilium.io",
          resource: "ciliumclusterwidenetworkpolicies",
          scope: "cluster",
        },
      ],
    };
    for (const [kind, plural, group] of [
      ["Pod", "pods", ""],
      ["PersistentVolumeClaim", "persistentvolumeclaims", ""],
      ["NetworkPolicy", "networkpolicies", "networking.k8s.io"],
    ] as const)
      for (const [method, verb] of [
        ["read", "get"],
        ["create", "create"],
        ["replace", "update"],
        ["delete", "delete"],
      ] as const)
        grants[`${method}Namespaced${kind}`] = [{ verb, group, resource: plural }];
    const kubeconfig = JSON.stringify({
      apiVersion: "v1",
      kind: "Config",
      clusters: [{ name: "fixture", cluster: { server: "https://kubernetes.example.test" } }],
      users: [{ name: "fixture", user: { token: "fixture-token" } }],
      contexts: [{ name: "fixture", context: { cluster: "fixture", user: "fixture" } }],
      "current-context": "fixture",
    });
    const provider = new KubernetesSandboxProvider(
      await createKubernetesApi({ inline: kubeconfig }, "computers", "fixture"),
      settings,
    );
    await provider.test(context);
    await provider.namespaces();
    const request = { botId: "bot", homePath: "/unused" };
    const computer = await provider.provision(request, context);
    await provider.prepare(computer, context);
    const events = [];
    for await (const event of provider.execute(computer, { argv: ["true"] }, context))
      events.push(event);
    expect(events.at(-1)).toEqual({ type: "exit", code: 0 });
    // With Cilium enforcing policy, turning the network off and on again uses NetworkPolicies.
    direct.cilium = true;
    await provider.provision({ ...request, networkEgress: false }, context);
    await provider.provision({ ...request, networkEgress: false }, context);
    await provider.provision(request, context);
    await provider.destroy(computer, context);
    const seen = new Set(
      direct.calls.flatMap((call) => {
        const mapped = grants[call];
        if (!mapped) throw new Error(`Unmapped client call: ${call}`);
        return mapped.map(key);
      }),
    );
    const listed = KUBERNETES_ACCESS.filter((access) => access.transports.includes("direct"));
    expect(seen).toEqual(new Set(listed.map(key)));
  });

  it("without the capacity ClusterRole, capacity is unknown and the connection still tests and runs", async () => {
    const unknown = {
      source: "not-reported",
      cpuCount: null,
      cpuLoad1m: null,
      memoryTotal: null,
      memoryFree: null,
      diskFree: null,
    };
    const api = Object.assign(new FakeKubernetesApi(), {
      capacity: async (): Promise<never> => {
        throw Object.assign(new Error("forbidden"), { code: 403 });
      },
      version: async () => "v1.31.2",
    });
    try {
      const provider = new KubernetesSandboxProvider(api, settings);
      expect(await provider.test(context)).toMatchObject({ version: "v1.31.2", capacity: unknown });
      const computer = await provider.provision({ botId: "bot", homePath: "/unused" }, context);
      await provider.prepare(computer, context);
    } finally {
      api.dispose();
    }
    const client = {
      async *request(operation: RemoteComputerCall) {
        // The host's kubectl is refused listing nodes; it reports only that the call failed.
        if (operation.action.type === "kube.capacity") throw new Error("Host operation failed.");
        yield { channel: "result" as const, data: "v1.31.2" };
      },
    };
    const remote = new HostKubernetesSandboxProvider("saved", settings, client as never);
    expect(await remote.test(context)).toMatchObject({ version: "v1.31.2", capacity: unknown });
  });
});
