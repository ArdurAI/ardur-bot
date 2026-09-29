/** A Kubernetes API permission, named the way RBAC names it. */
export type KubernetesAccess = {
  /** Why the provider asks: every computer operation, or one of the optional features. */
  readonly purpose: "computers" | "capacity" | "namespaces" | "egress";
  /** The direct API client, or kubectl on the owner's host. */
  readonly transports: readonly ("direct" | "host")[];
  readonly verb: "get" | "list" | "create" | "update" | "delete";
  /** "" is the core API group. */
  readonly group: string;
  readonly resource: string;
  readonly subresource?: string;
  /** Unset means the computers' own namespace. */
  readonly scope?: "cluster" | "kube-system";
};

const both = ["direct", "host"] as const;
const direct = ["direct"] as const;

/**
 * Every API permission the Kubernetes transports use. infra/sandboxes/kubernetes/role.yaml grants
 * all `computers` entries and make-kubeconfig.sh checks them. The optional capacity-clusterrole.yaml
 * grants `capacity`; without it capacity is unknown. Without `egress` a computer cannot have its
 * network turned off on the cluster, and nothing in Settings lists namespaces today.
 */
export const KUBERNETES_ACCESS: readonly KubernetesAccess[] = [
  { purpose: "computers", transports: both, verb: "get", group: "", resource: "pods" },
  { purpose: "computers", transports: both, verb: "create", group: "", resource: "pods" },
  { purpose: "computers", transports: both, verb: "delete", group: "", resource: "pods" },
  {
    purpose: "computers",
    transports: both,
    verb: "get",
    group: "",
    resource: "persistentvolumeclaims",
  },
  {
    purpose: "computers",
    transports: both,
    verb: "create",
    group: "",
    resource: "persistentvolumeclaims",
  },
  {
    purpose: "computers",
    transports: both,
    verb: "delete",
    group: "",
    resource: "persistentvolumeclaims",
  },
  // WebSocket exec starts with a GET; SPDY exec, and newer API servers for WebSockets too, need create.
  {
    purpose: "computers",
    transports: both,
    verb: "get",
    group: "",
    resource: "pods",
    subresource: "exec",
  },
  {
    purpose: "computers",
    transports: both,
    verb: "create",
    group: "",
    resource: "pods",
    subresource: "exec",
  },
  {
    purpose: "capacity",
    transports: both,
    verb: "list",
    group: "",
    resource: "nodes",
    scope: "cluster",
  },
  {
    purpose: "capacity",
    transports: both,
    verb: "list",
    group: "",
    resource: "pods",
    scope: "cluster",
  },
  {
    purpose: "capacity",
    transports: both,
    verb: "list",
    group: "metrics.k8s.io",
    resource: "nodes",
    scope: "cluster",
  },
  {
    purpose: "namespaces",
    transports: both,
    verb: "list",
    group: "",
    resource: "namespaces",
    scope: "cluster",
  },
  {
    purpose: "egress",
    transports: direct,
    verb: "get",
    group: "apps",
    resource: "daemonsets",
    scope: "kube-system",
  },
  {
    purpose: "egress",
    transports: direct,
    verb: "get",
    group: "",
    resource: "configmaps",
    scope: "kube-system",
  },
  ...(["get", "list", "create", "update", "delete"] as const).map((verb) => ({
    purpose: "egress" as const,
    transports: direct,
    verb,
    group: "networking.k8s.io",
    resource: "networkpolicies",
  })),
  {
    purpose: "egress",
    transports: direct,
    verb: "list",
    group: "cilium.io",
    resource: "ciliumnetworkpolicies",
  },
  {
    purpose: "egress",
    transports: direct,
    verb: "list",
    group: "cilium.io",
    resource: "ciliumclusterwidenetworkpolicies",
    scope: "cluster",
  },
];
