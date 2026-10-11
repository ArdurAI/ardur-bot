import {
  discoverOllama,
  normalizeOllamaUrl,
  ollamaErrorMessage,
  parseModelSecret,
} from "@ardurbot/adapters";
import type { Actor, OllamaStatus } from "@ardurbot/contracts";
import { defaultOllamaUrl } from "@ardurbot/contracts";
import { findBoundModelCredential, findModelCredential } from "@ardurbot/db";
import type { RouterDeps } from "./router.js";

export async function ollamaConnection(deps: RouterDeps, actor: Actor, credentialId?: string) {
  const credential = credentialId
    ? await findBoundModelCredential(deps.prisma, actor, "ollama", credentialId)
    : await findModelCredential(deps.prisma, actor, "ollama");
  if (credentialId && !credential) throw new Error("Connect Ollama again.");
  if (!credential) return undefined;
  const secret = await deps.prisma.secret.findFirst({
    where: { id: credential.secretId, userId: actor.userId, spaceId: null },
  });
  if (!secret) throw new Error("Connect Ollama again.");
  const parsed = parseModelSecret(deps.secrets.load(secret.ciphertext, secret.id));
  if (parsed.kind !== "openai_compatible") throw new Error("Connect Ollama again.");
  return { credentialId: credential.id, baseUrl: normalizeOllamaUrl(parsed.baseUrl) };
}

export async function ollamaStatus(
  deps: RouterDeps,
  actor: Actor,
  signal?: AbortSignal,
  testUrl?: string,
  credentialId?: string,
): Promise<OllamaStatus> {
  let status: OllamaStatus = {
    baseUrl: defaultOllamaUrl(
      deps.env.deploymentKind ?? (deps.env.desktopStackToken ? "packaged" : "source"),
    ),
    models: [],
    canPull: actor.isDeploymentOwner === true,
  };
  try {
    const connection =
      testUrl === undefined ? await ollamaConnection(deps, actor, credentialId) : undefined;
    if (connection) status = { ...status, ...connection };
    if (testUrl !== undefined) status.baseUrl = normalizeOllamaUrl(testUrl);
    if (!connection && testUrl === undefined) return status;
    signal?.throwIfAborted();
    return { ...status, ...(await discoverOllama(status.baseUrl, signal)) };
  } catch (error) {
    return { ...status, issue: ollamaErrorMessage(error) };
  }
}

/** Discovery is optional catalog enrichment, bounded across all saved servers. */
export async function ollamaCatalogStates(
  deps: RouterDeps,
  actor: Actor,
  credentialIds: readonly string[],
  signal?: AbortSignal,
): Promise<OllamaStatus[]> {
  if (!credentialIds.length || signal?.aborted) return [];
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new DOMException("Catalog discovery timed out", "TimeoutError")),
    3_000,
  );
  const scoped = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const states: (OllamaStatus | undefined)[] = Array(credentialIds.length);
  let next = 0;
  let onAbort!: () => void;
  const stopped = new Promise<void>((resolve) => {
    onAbort = resolve;
    scoped.addEventListener("abort", onAbort, { once: true });
  });
  async function discoverNext() {
    while (!scoped.aborted && next < credentialIds.length) {
      const index = next++;
      const state = await ollamaStatus(deps, actor, scoped, undefined, credentialIds[index]);
      if (!scoped.aborted) states[index] = state;
    }
  }
  try {
    await Promise.race([
      Promise.all(Array.from({ length: Math.min(3, credentialIds.length) }, discoverNext)),
      stopped,
    ]);
    return states.filter((state): state is OllamaStatus => state !== undefined);
  } finally {
    clearTimeout(timer);
    scoped.removeEventListener("abort", onAbort);
  }
}
