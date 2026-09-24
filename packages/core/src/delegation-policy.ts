import type {
  DelegationAuthority,
  DelegationSnapshot,
  LocalityPolicy,
  ModelDestination,
} from "@ardurbot/contracts";

export function intersectDelegationAuthority(
  ...layers: readonly DelegationAuthority[]
): DelegationAuthority {
  const intersect = (key: keyof DelegationAuthority) =>
    [...new Set(layers[0]?.[key] ?? [])].filter((value) =>
      layers.every((layer) => layer[key].includes(value)),
    );
  return { scopes: intersect("scopes"), connectors: intersect("connectors") };
}
export function allowsModelDestination(
  policy: LocalityPolicy,
  destination: ModelDestination,
): boolean {
  if (policy.mode === "any") return true;
  if (policy.mode === "local") return destination.local && destination.host !== null;
  return (
    destination.host !== null &&
    policy.hosts.some((host) => host.toLowerCase() === destination.host!.toLowerCase())
  );
}
/** Only loopback endpoints are local; a provider's display name is not evidence. */
export function modelDestination(endpoint?: string): ModelDestination {
  try {
    const url = new URL(endpoint ?? "");
    if (!["http:", "https:"].includes(url.protocol)) return { host: null, local: false };
    const host = url.hostname.toLowerCase();
    return {
      host,
      local: host === "localhost" || host === "[::1]" || /^127\.(\d{1,3}\.){2}\d{1,3}$/.test(host),
    };
  } catch {
    return { host: null, local: false };
  }
}
export function delegationDifferences(
  parent: DelegationSnapshot,
  target: DelegationSnapshot,
  name: string,
): string[] {
  const changed = ["provider", "modelId", "effort", "credentialId", "runtimeKind"].some(
    (key) =>
      parent.pin[key as keyof typeof parent.pin] !== target.pin[key as keyof typeof target.pin],
  );
  const computer =
    parent.computer.id !== target.computer.id ||
    parent.computer.mode !== target.computer.mode ||
    parent.computer.kind !== target.computer.kind;
  if (!changed && !computer) return [];
  return [
    `${name} runs on ${target.pin.modelId} (${target.pin.provider}) at ${target.pin.effort}, on ${target.computer.mode === "dedicated" ? "a dedicated" : "a team"} computer${parent.pin.credentialId !== target.pin.credentialId ? ", using a different connection" : ""}${parent.pin.runtimeKind !== target.pin.runtimeKind ? `, with ${target.pin.runtimeKind ?? "pi"}` : ""}.`,
  ];
}
