import { ComputerConnectionSettingsSchema } from "@ardurbot/contracts";
import { expect, it } from "vitest";
import type { KubernetesObject } from "./kubernetes-spec.js";
import { kubernetesComputerSpec } from "./kubernetes-spec.js";

type SecurityContext = {
  privileged?: boolean;
  allowPrivilegeEscalation?: boolean;
  runAsNonRoot?: boolean;
  runAsUser?: number;
  procMount?: string;
  capabilities?: { add?: string[]; drop?: string[] };
  seccompProfile?: { type?: string };
  appArmorProfile?: { type?: string };
  seLinuxOptions?: { type?: string; user?: string; role?: string };
  sysctls?: { name: string }[];
};
type Container = { securityContext?: SecurityContext; ports?: { hostPort?: number }[] };
type PodSpec = {
  hostNetwork?: boolean;
  hostPID?: boolean;
  hostIPC?: boolean;
  securityContext?: SecurityContext;
  volumes?: Record<string, unknown>[];
  containers?: Container[];
  initContainers?: Container[];
  ephemeralContainers?: Container[];
};

const SAFE_SYSCTLS = new Set([
  "kernel.shm_rmid_forced",
  "net.ipv4.ip_local_port_range",
  "net.ipv4.ip_unprivileged_port_start",
  "net.ipv4.tcp_syncookies",
  "net.ipv4.ping_group_range",
  "net.ipv4.ip_local_reserved_ports",
  "net.ipv4.tcp_keepalive_time",
  "net.ipv4.tcp_fin_timeout",
  "net.ipv4.tcp_keepalive_intvl",
  "net.ipv4.tcp_keepalive_probes",
]);
const RESTRICTED_VOLUMES = [
  "configMap",
  "csi",
  "downwardAPI",
  "emptyDir",
  "ephemeral",
  "persistentVolumeClaim",
  "projected",
  "secret",
];

/** The Baseline and Restricted controls of the Kubernetes Pod Security Standards. */
function restrictedViolations(pod: KubernetesObject) {
  const spec = pod.spec as PodSpec;
  const podContext = spec.securityContext ?? {};
  const containers = [
    ...(spec.containers ?? []),
    ...(spec.initContainers ?? []),
    ...(spec.ephemeralContainers ?? []),
  ];
  const violations: string[] = [];
  const check = (ok: boolean, control: string) => ok || violations.push(control);
  check(!spec.hostNetwork && !spec.hostPID && !spec.hostIPC, "host namespaces");
  for (const volume of spec.volumes ?? [])
    check(
      RESTRICTED_VOLUMES.some((type) => type in volume) && !("hostPath" in volume),
      "volume types",
    );
  for (const context of [podContext, ...containers.map((c) => c.securityContext ?? {})]) {
    check(!["Unconfined"].includes(context.appArmorProfile?.type ?? ""), "AppArmor");
    check(
      ["", "container_t", "container_init_t", "container_kvm_t", "container_engine_t"].includes(
        context.seLinuxOptions?.type ?? "",
      ) &&
        !context.seLinuxOptions?.user &&
        !context.seLinuxOptions?.role,
      "SELinux",
    );
    check(context.runAsUser !== 0, "running as non-root user");
    check(context.seccompProfile?.type !== "Unconfined", "seccomp");
  }
  check(
    (podContext.sysctls ?? []).every((sysctl) => SAFE_SYSCTLS.has(sysctl.name)),
    "sysctls",
  );
  for (const container of containers) {
    const context = container.securityContext ?? {};
    check(!context.privileged, "privileged containers");
    check(
      (context.capabilities?.add ?? []).every((capability) => capability === "NET_BIND_SERVICE"),
      "capabilities added",
    );
    check(context.capabilities?.drop?.includes("ALL") === true, "capabilities dropped");
    check(context.allowPrivilegeEscalation === false, "privilege escalation");
    check(!context.procMount || context.procMount === "Default", "/proc mount type");
    check(
      (container.ports ?? []).every((port) => !port.hostPort),
      "host ports",
    );
    check(
      context.runAsNonRoot === true ||
        (podContext.runAsNonRoot === true && context.runAsNonRoot !== false),
      "running as non-root",
    );
    check(
      ["RuntimeDefault", "Localhost"].includes(
        context.seccompProfile?.type ?? podContext.seccompProfile?.type ?? "",
      ),
      "seccomp profile set",
    );
  }
  return violations;
}

it("renders a pod the restricted Pod Security level admits, for every profile and option", () => {
  for (const profile of ["base", "developer"] as const)
    for (const extra of [{}, { imagePullSecret: "registry-login" }]) {
      const settings = ComputerConnectionSettingsSchema.parse({ engine: "kubernetes", ...extra });
      const pod = kubernetesComputerSpec("ardurbot-computer", profile, settings);
      expect(restrictedViolations(pod), `${profile} ${JSON.stringify(extra)}`).toEqual([]);
      expect(pod.spec).toMatchObject({
        automountServiceAccountToken: false,
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          seccompProfile: { type: "RuntimeDefault" },
        },
        containers: [
          {
            imagePullPolicy: "IfNotPresent",
            securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
          },
        ],
      });
    }
});

it("names each restricted control a pod breaks", () => {
  const settings = ComputerConnectionSettingsSchema.parse({ engine: "kubernetes" });
  const pod = structuredClone(kubernetesComputerSpec("ardurbot-computer", "base", settings));
  const spec = pod.spec as PodSpec;
  spec.hostPID = true;
  spec.volumes = [...(spec.volumes ?? []), { name: "host", hostPath: { path: "/" } }];
  spec.securityContext = { ...spec.securityContext, runAsUser: 0, seccompProfile: {} };
  spec.containers![0]!.securityContext = { privileged: true, capabilities: { add: ["SYS_ADMIN"] } };
  expect(restrictedViolations(pod)).toEqual(
    expect.arrayContaining([
      "host namespaces",
      "volume types",
      "running as non-root user",
      "privileged containers",
      "capabilities added",
      "capabilities dropped",
      "privilege escalation",
      "seccomp profile set",
    ]),
  );
});
