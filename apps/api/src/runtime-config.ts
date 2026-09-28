import {
  modelCredentialDto,
  NATIVE_HOST_OWNER_MESSAGE,
  nativeHostOwner,
  parseModelSecret,
  showOllamaModel,
} from "@ardurbot/adapters";
import { ThinkingLevelSchema } from "@ardurbot/contracts";
import { appContract } from "@ardurbot/contracts/rpc";
import { parseRuntimeConfigText } from "@ardurbot/contracts/runtime-config-editor";
import { normalizeHermesRuntimeConfig } from "@ardurbot/core/runtime-config";
import { findBoundModelCredential } from "@ardurbot/db";
import {
  compileHermesRuntimeConfig,
  type HermesConfigModel,
} from "@ardurbot/host-runtime/runtimes/hermes-config";
import type { Router } from "@orpc/server";
import { implement, ORPCError } from "@orpc/server";
import type { RouterContext } from "./customization-routes.js";
import { validateModelPinSelection } from "./model-pin-validation.js";
import type { RouterDeps } from "./router.js";

const runtimeConfigContract = { runtimeConfig: appContract.runtimeConfig };

export function createRuntimeConfigRoutes(
  deps: RouterDeps,
): Router<typeof runtimeConfigContract, RouterContext> {
  const base = implement(runtimeConfigContract).$context<RouterContext>();
  const authed = base.use(async ({ context, next }) => {
    if (!context.actor) throw new ORPCError("UNAUTHORIZED");
    return next({ context: { ...context, actor: context.actor } });
  });
  return base.router({
    runtimeConfig: {
      preview: authed.runtimeConfig.preview.handler(async ({ context, input }) => {
        if (input.runtimeKind !== "hermes" || input.pin.runtimeKind !== "hermes") {
          throw new ORPCError("BAD_REQUEST", {
            message: "Only Hermes configuration can be previewed.",
          });
        }
        if (!(await nativeHostOwner(deps.prisma, context.actor.userId)))
          throw new ORPCError("FORBIDDEN", { message: NATIVE_HOST_OWNER_MESSAGE });
        const parsed = parseRuntimeConfigText(JSON.stringify(input.runtimeConfig ?? null));
        if (!parsed.success) return { issues: parsed.issues };

        const validatedPin = await validateModelPinSelection(deps, context.actor, input.pin);

        const provider = validatedPin.provider!;
        const modelId = validatedPin.modelId!;
        const credentialId = validatedPin.credentialId!;
        const effort = validatedPin.effort;

        const credential = await findBoundModelCredential(
          deps.prisma,
          context.actor,
          provider,
          credentialId,
        );
        if (!credential) {
          throw new ORPCError("BAD_REQUEST", { message: "Connection not found." });
        }

        let contextWindow = 8192;
        let maxTokens = 4096;
        let reasoning = false;
        let acceptsImages = false;
        const thinkingLevel =
          effort === "off" || effort === "none" || !effort
            ? "off"
            : ThinkingLevelSchema.parse(effort);

        if (provider === "ollama") {
          const secret = await deps.prisma.secret.findFirst({
            where: { id: credential.secretId, userId: context.actor.userId, spaceId: null },
          });
          if (!secret) throw new ORPCError("BAD_REQUEST", { message: "Secret not found." });
          const connection = parseModelSecret(deps.secrets.load(secret.ciphertext, secret.id));
          if (connection.kind === "openai_compatible") {
            const ollamaModel = await showOllamaModel(connection.baseUrl, modelId);
            contextWindow = ollamaModel.contextWindow || 8192;
            maxTokens = Math.max(1, Math.min(4096, Math.floor(contextWindow / 4)));
            reasoning = ollamaModel.reasoning;
          }
        } else if (provider === "openai-compatible") {
          const secret = await deps.prisma.secret.findFirst({
            where: { id: credential.secretId, userId: context.actor.userId, spaceId: null },
          });
          if (!secret) throw new ORPCError("BAD_REQUEST", { message: "Connection not found." });
          const metadata = modelCredentialDto(
            credential,
            deps.secrets.load(secret.ciphertext, secret.id),
          );
          contextWindow = metadata.contextWindow ?? 8192;
          maxTokens = metadata.maxTokens ?? 4096;
          reasoning = metadata.reasoning ?? false;
          acceptsImages = metadata.supportsImages ?? false;
        } else {
          throw new ORPCError("BAD_REQUEST", { message: "Hermes needs a qualified connection." });
        }

        const modelConfig: HermesConfigModel = {
          id: modelId,
          contextWindow,
          maxTokens,
          reasoning,
          acceptsImages,
          thinkingLevel,
        };

        const document = normalizeHermesRuntimeConfig(parsed.document);
        const compiled = compileHermesRuntimeConfig(document, modelConfig);

        return {
          preview: compiled.preview,
          issues: [],
        };
      }),
    },
  });
}
