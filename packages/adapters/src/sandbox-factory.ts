import { existsSync, readFileSync } from "node:fs";
import type { SandboxProvider } from "@ardurbot/adapter-kit";
import type { ComputerConnectionSettings } from "@ardurbot/contracts";
import { ComputerConnectionSettingsSchema } from "@ardurbot/contracts";
import type { HostClient } from "@ardurbot/host-runtime/host-client";
import { BoxSandboxEmulator } from "./box-emulator.js";
import { BoxSandboxProvider } from "./box-sandbox.js";
import { DaytonaSandboxEmulator } from "./daytona-emulator.js";
import { DaytonaSandboxProvider } from "./daytona-sandbox.js";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { DockerSandboxProvider } from "./docker-sandbox.js";
import { ManagedSandboxEmulator } from "./e2b-emulator.js";
import { E2BSandboxProvider } from "./e2b-sandbox.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import type { KubernetesApi } from "./kubernetes-client.js";
import { createInClusterKubernetesApi } from "./kubernetes-client.js";
import { KubernetesSandboxProvider } from "./kubernetes-sandbox.js";
import { NoneSandboxProvider } from "./none-sandbox.js";

export interface SandboxProviderOptions {
  hostClient?: Pick<HostClient, "request" | "result" | "health">;
  kubernetes?: { api: KubernetesApi; settings: ComputerConnectionSettings };
  supervisorUrl?: string;
  supervisorToken?: string;
  e2bApiKey?: string;
  daytonaApiKey?: string;
  daytonaApiUrl?: string;
  daytonaTarget?: string;
  boxApiKey?: string;
  boxApiUrl?: string;
  dataDir?: string;
  /** Extra kind → provider factories for computers that are not the deployment default. */
  providers?: Partial<Record<string, () => SandboxProvider>>;
}

/** One instance per factory. Docker and the host use the same shape. */
export function lazy<T>(create: () => T): () => T {
  let value: T | undefined;
  return () => {
    value ??= create();
    return value;
  };
}

/** Each kind factory constructs once, so later calls share that instance. */
export function memoizeProviders(
  factories: Partial<Record<string, () => SandboxProvider>> | undefined,
): Partial<Record<string, () => SandboxProvider>> {
  const providers: Partial<Record<string, () => SandboxProvider>> = {};
  for (const [kind, create] of Object.entries(factories ?? {})) {
    if (create) providers[kind] = lazy(create);
  }
  return providers;
}

function missingRemoteKey(provider: "e2b" | "daytona" | "box", envName: string): SandboxProvider {
  return new NoneSandboxProvider(
    `Computers unavailable: ${envName} is required for SANDBOX_PROVIDER=${provider}.`,
  );
}

const SERVICE_ACCOUNT_NAMESPACE = "/var/run/secrets/kubernetes.io/serviceaccount/namespace";

/** Same environment loadFromCluster reads for a process running on Kubernetes. */
export function kubernetesDeploymentConfigured(env: NodeJS.ProcessEnv = process.env) {
  return Boolean(env.KUBERNETES_SERVICE_HOST?.trim());
}

function deploymentNamespace() {
  try {
    if (!existsSync(SERVICE_ACCOUNT_NAMESPACE)) return "ardurbot";
    const value = readFileSync(SERVICE_ACCOUNT_NAMESPACE, "utf8").trim();
    if (/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(value)) return value;
  } catch {
    // An unreadable service-account file keeps the computer namespace default.
  }
  return "ardurbot";
}

function inClusterApi(namespace: string): KubernetesApi {
  let ready: Promise<KubernetesApi> | undefined;
  const client = () => (ready ??= createInClusterKubernetesApi(namespace));
  return {
    capacity: () =>
      client().then((api) => api.capacity?.() ?? Promise.resolve({ nodes: [], pods: [] })),
    namespaces: () => client().then((api) => api.namespaces?.() ?? Promise.resolve([namespace])),
    supportsEgress: (signal) =>
      client().then((api) => api.supportsEgress?.(signal) ?? Promise.resolve(false)),
    setEgress: (name, enabled, signal) =>
      client().then((api) => api.setEgress?.(name, enabled, signal) ?? Promise.resolve()),
    read: (resource, name, signal) => client().then((api) => api.read(resource, name, signal)),
    create: (resource, body, signal) => client().then((api) => api.create(resource, body, signal)),
    remove: (resource, name, signal) => client().then((api) => api.remove(resource, name, signal)),
    exec: (name, argv, signal, input) =>
      (async function* () {
        yield* (await client()).exec(name, argv, signal, input);
      })(),
  };
}

function deploymentKubernetes(): SandboxProvider {
  const namespace = deploymentNamespace();
  return new KubernetesSandboxProvider(
    inClusterApi(namespace),
    ComputerConnectionSettingsSchema.parse({
      engine: "kubernetes",
      context: "inClusterContext",
      namespace,
    }),
  );
}

/** Providers for connectionless computers whose kind is not the deployment default. */
export function sandboxProvidersForKeys(
  opts: SandboxProviderOptions,
): NonNullable<SandboxProviderOptions["providers"]> {
  const providers: NonNullable<SandboxProviderOptions["providers"]> = {};
  if (opts.e2bApiKey?.trim()) providers.e2b = () => createSandboxProvider("e2b", opts);
  if (opts.daytonaApiKey?.trim()) providers.daytona = () => createSandboxProvider("daytona", opts);
  if (opts.boxApiKey?.trim()) providers.box = () => createSandboxProvider("box", opts);
  if (kubernetesDeploymentConfigured()) {
    providers.kubernetes = () =>
      opts.kubernetes
        ? new KubernetesSandboxProvider(opts.kubernetes.api, opts.kubernetes.settings)
        : deploymentKubernetes();
  }
  return memoizeProviders(providers);
}

export function createSandboxProvider(kind: string, opts: SandboxProviderOptions): SandboxProvider {
  switch (kind) {
    case "none":
    case "":
      return new NoneSandboxProvider();
    case "e2b":
      if (!opts.e2bApiKey?.trim()) return missingRemoteKey("e2b", "E2B_API_KEY");
      return new E2BSandboxProvider(opts.e2bApiKey);
    case "daytona":
      if (!opts.daytonaApiKey?.trim()) return missingRemoteKey("daytona", "DAYTONA_API_KEY");
      return new DaytonaSandboxProvider({
        apiKey: opts.daytonaApiKey,
        apiUrl: opts.daytonaApiUrl,
        target: opts.daytonaTarget,
      });
    case "box":
      if (!opts.boxApiKey?.trim()) return missingRemoteKey("box", "BOX_API_KEY");
      return new BoxSandboxProvider({ apiKey: opts.boxApiKey, apiUrl: opts.boxApiUrl });
    case "kubernetes":
      if (opts.kubernetes)
        return new KubernetesSandboxProvider(opts.kubernetes.api, opts.kubernetes.settings);
      if (kubernetesDeploymentConfigured()) return deploymentKubernetes();
      throw new Error("Choose a Kubernetes connection in Settings → Computers.");
    case "docker":
      return new DockerSandboxProvider(
        opts.supervisorUrl ?? "http://127.0.0.1:7091",
        opts.supervisorToken,
      );
    case "e2b-emulator":
      return new ManagedSandboxEmulator();
    case "daytona-emulator":
      return new DaytonaSandboxEmulator();
    case "box-emulator":
      return new BoxSandboxEmulator();
    case "desktop":
      return new DesktopSandboxProvider({
        root: opts.dataDir,
      });
    case "fake":
      return new FakeSandboxProvider();
    default:
      throw new Error(
        `Unknown SANDBOX_PROVIDER "${kind}". Use none | docker | kubernetes | e2b | daytona | box | e2b-emulator | daytona-emulator | box-emulator | desktop | fake.`,
      );
  }
}
