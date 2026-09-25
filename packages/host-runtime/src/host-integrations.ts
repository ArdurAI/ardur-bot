import type { HostIntegration, HostIntegrationId } from "@ardurbot/contracts/host-integrations";
import { HOST_INTEGRATIONS, hostIntegrationCommand } from "@ardurbot/contracts/host-integrations";
import { getHostEnvironment, hostProbe, resolveHostBinary } from "./host-environment.js";

const text = (value: unknown) =>
  typeof value === "string"
    ? value
        .split("")
        .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
        .join("")
        .trim()
        .slice(0, 240) || null
    : null;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Select identity fields only. Never return auth status prose, config or token fields. */
export function parseHostIdentity(
  id: HostIntegrationId,
  output: string,
): Pick<HostIntegration, "identity" | "workspace"> {
  let value: Record<string, unknown> = {};
  try {
    value = record(JSON.parse(output));
  } catch {
    /* Text-only CLIs below. */
  }
  if (id === "github") {
    for (const [host, accounts] of Object.entries(record(value.hosts))) {
      if (!Array.isArray(accounts)) continue;
      const active = accounts
        .map(record)
        .find((account) => account.active === true && account.state === "success");
      if (active) return { identity: text(active.login), workspace: text(host) };
    }
  }
  if (id === "gitlab")
    return {
      identity: text(output.match(/Logged in to \S+ as ([^\s(]+)/i)?.[1]),
      workspace: text(output.match(/Logged in to (\S+) as/i)?.[1]),
    };
  if (id === "aws") return { identity: text(value.Arn), workspace: text(value.Account) };
  if (id === "google-cloud")
    return {
      identity: text(record(value.core).account),
      workspace: text(record(value.core).project),
    };
  if (id === "azure")
    return { identity: text(record(value.user).name), workspace: text(value.name) };
  if (id === "kubernetes")
    return { identity: text(output.split(/\r?\n/)[0]), workspace: text(output.split(/\r?\n/)[0]) };
  if (id === "jenkins") {
    const identity = text(output.match(/Authenticated as:\s*([^\r\n]+)/i)?.[1]);
    return { identity: identity === "anonymous" ? null : identity, workspace: null };
  }
  return { identity: null, workspace: null };
}

let cached: { at: number; result: Promise<HostIntegration[]> } | undefined;
export function inspectHostIntegrations(force = false): Promise<HostIntegration[]> {
  if (!force && cached && Date.now() - cached.at < 30_000) return cached.result;
  const result = detectHostIntegrations();
  cached = { at: Date.now(), result };
  return result;
}

export async function detectHostIntegrations(
  deps = { getHostEnvironment, resolveHostBinary, hostProbe },
): Promise<HostIntegration[]> {
  const { env } = await deps.getHostEnvironment();
  return Promise.all(
    Object.entries(HOST_INTEGRATIONS).map(async ([id, definition]): Promise<HostIntegration> => {
      const binary = await deps.resolveHostBinary(definition.command, env);
      const base = {
        id: id as HostIntegrationId,
        command: definition.command,
        identity: null,
        workspace: null,
        checkedAt: new Date().toISOString(),
      };
      if (!binary) return { ...base, state: "not-found" };
      const probe = await deps.hostProbe(
        binary,
        [...definition.args],
        env,
        true,
        8000,
        process.platform,
        id === "gitlab",
      );
      const identity =
        !probe.failure && probe.code === 0
          ? parseHostIdentity(base.id, probe.output)
          : { identity: null, workspace: null };
      if (id === "jenkins" && env.JENKINS_URL && identity.identity)
        identity.workspace = new URL(env.JENKINS_URL).host;
      return {
        ...base,
        ...identity,
        state: identity.identity
          ? "signed-in"
          : probe.failure || probe.code !== 0
            ? "unavailable"
            : "needs-sign-in",
      };
    }),
  );
}

/** Recheck on the host immediately before execution; an account switch never inherits grants. */
export async function verifyHostIntegration(
  expected: { id: HostIntegrationId; identity: string; workspace: string | null },
  argv: string[],
  deps = { getHostEnvironment, resolveHostBinary, hostProbe },
) {
  const definition = HOST_INTEGRATIONS[expected.id];
  const permitted = hostIntegrationCommand(expected.id, { args: argv.slice(1) });
  if (JSON.stringify(permitted) !== JSON.stringify(argv))
    throw new Error("Invalid integration command.");
  const { env } = await deps.getHostEnvironment();
  const binary = await deps.resolveHostBinary(definition.command, env);
  if (!binary) throw new Error("Integration CLI is unavailable.");
  const probe = await deps.hostProbe(
    binary,
    [...definition.args],
    env,
    true,
    8000,
    process.platform,
    expected.id === "gitlab",
  );
  if (probe.failure || probe.code !== 0)
    throw new Error("Could not verify the CLI sign-in. Try again.");
  const identity = parseHostIdentity(expected.id, probe.output);
  if (expected.id === "jenkins" && env.JENKINS_URL)
    identity.workspace = new URL(env.JENKINS_URL).host;
  if (identity.identity !== expected.identity || identity.workspace !== expected.workspace)
    throw new Error("The CLI account changed. Reconnect this integration.");
}
