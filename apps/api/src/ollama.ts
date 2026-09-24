import {
  discoverOllama,
  normalizeOllamaUrl,
  ollamaErrorMessage,
  parseModelSecret,
} from "@ardurbot/adapters";
import type { Actor, OllamaStatus } from "@ardurbot/contracts";
import { defaultOllamaUrl } from "@ardurbot/contracts";
import { findModelCredential } from "@ardurbot/db";
import type { RouterDeps } from "./router.js";

export async function ollamaConnection(deps: RouterDeps, actor: Actor) {
  const credential = await findModelCredential(deps.prisma, actor, "ollama");
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
): Promise<OllamaStatus> {
  let status: OllamaStatus = {
    baseUrl: defaultOllamaUrl(
      deps.env.deploymentKind ?? (deps.env.desktopStackToken ? "packaged" : "source"),
    ),
    models: [],
    canPull: actor.isDeploymentOwner === true,
  };
  try {
    const connection = testUrl === undefined ? await ollamaConnection(deps, actor) : undefined;
    if (connection) status = { ...status, ...connection };
    if (testUrl !== undefined) status.baseUrl = normalizeOllamaUrl(testUrl);
    if (!connection && testUrl === undefined) return status;
    return { ...status, ...(await discoverOllama(status.baseUrl, signal)) };
  } catch (error) {
    return { ...status, issue: ollamaErrorMessage(error) };
  }
}
