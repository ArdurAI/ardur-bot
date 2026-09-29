import type { ComputerConnectionSettings, ComputerProfileId } from "@ardurbot/contracts";
import { connectionComputerImage } from "./computer-image.js";

export type KubernetesObject = {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    labels?: Record<string, string>;
    deletionTimestamp?: string;
    uid?: string;
  };
  spec?: Record<string, unknown>;
  status?: { phase?: string; conditions?: { type?: string; status?: string }[] };
};
const HOME = "/home/ardurbot";
export function kubernetesComputerSpec(
  name: string,
  profile: ComputerProfileId | undefined,
  settings: ComputerConnectionSettings,
  image = connectionComputerImage(profile ?? "base", settings),
): KubernetesObject {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name, labels: { "ardurbot.com/computer": name } },
    spec: {
      restartPolicy: "Always",
      automountServiceAccountToken: false,
      ...(settings.imagePullSecret
        ? { imagePullSecrets: [{ name: settings.imagePullSecret }] }
        : {}),
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        fsGroupChangePolicy: "OnRootMismatch",
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [
        {
          name: "computer",
          image,
          imagePullPolicy: "IfNotPresent",
          command: ["/bin/sleep", "infinity"],
          workingDir: HOME,
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
          resources: {
            requests: { cpu: settings.cpuRequest, memory: settings.memoryRequest },
            limits: { cpu: settings.cpuLimit, memory: settings.memoryLimit },
          },
          volumeMounts: [
            { name: "home", mountPath: HOME },
            { name: "shm", mountPath: "/dev/shm" },
          ],
        },
      ],
      volumes: [
        { name: "home", persistentVolumeClaim: { claimName: name } },
        { name: "shm", emptyDir: { medium: "Memory", sizeLimit: "256Mi" } },
      ],
    },
  };
}

export function kubernetesVolumeSpec(
  name: string,
  settings: ComputerConnectionSettings,
): KubernetesObject {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: { name, labels: { "ardurbot.com/computer": name } },
    spec: {
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: settings.storageSize } },
      ...(settings.storageClass ? { storageClassName: settings.storageClass } : {}),
    },
  };
}
