import { ORPCError, implement, type Router } from "@orpc/server";
import { normalizedThinkingLevel, ThinkingLevelSchema } from "@ardurbot/contracts";
import { compileHermesRuntimeConfig, type HermesConfigModel } from "@ardurbot/host-runtime/runtimes/hermes-config";
import { migrateHermesRuntimeConfig } from "@ardurbot/core/runtime-config";
import { validateModelPinSelection } from "./model-pin-validation.js";
import { type RouterDeps } from "./router.js";
import type { RouterContext } from "./customization-routes.js";
import { findBoundModelCredential } from "@ardurbot/db";
import { 
  parseModelSecret, 
  listPiCatalog, 
  modelCredentialDto, 
  showOllamaModel 
} from "@ardurbot/adapters";
import { appContract } from "@ardurbot/contracts";

export const createRuntimeConfigRoutes = (deps: RouterDeps, authedRoutes: any) => ({
  runtimeConfig: {
    preview: authedRoutes.runtimeConfig.preview.handler(async ({ context, input }: { context: any, input: any }) => {
      if (input.runtimeKind !== "hermes") {
        throw new ORPCError("BAD_REQUEST", { message: "Only Hermes configuration can be previewed." });
      }
      
      const validatedPin = await validateModelPinSelection(deps, context.actor, input.pin);
      
      const provider = validatedPin.provider!;
      const modelId = validatedPin.modelId!;
      const credentialId = validatedPin.credentialId!;
      const effort = validatedPin.effort;

      const credential = await findBoundModelCredential(deps.prisma, context.actor, provider, credentialId);
      if (!credential) {
        throw new ORPCError("BAD_REQUEST", { message: "Connection not found." });
      }

      let contextWindow = 8192;
      let maxTokens = 4096;
      let reasoning = false;
      let acceptsImages = false;
      const thinkingLevel = (effort === "off" || effort === "none" || !effort) ? "off" : ThinkingLevelSchema.parse(effort);

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
        if (secret) {
          const metadata = modelCredentialDto(credential, deps.secrets.load(secret.ciphertext, secret.id));
          contextWindow = metadata.contextWindow ?? 8192;
          maxTokens = metadata.maxTokens ?? 4096;
          reasoning = Boolean(metadata.thinkingLevel && metadata.thinkingLevel !== "off");
          acceptsImages = 'acceptsImages' in metadata ? Boolean((metadata as any).acceptsImages) : false;
        }
      } else {
        const entry: any = listPiCatalog().find((item: any) => item.provider === provider && item.id === modelId);
        if (entry) {
           contextWindow = entry.contextWindow ?? 8192;
           maxTokens = entry.maxTokens ?? 4096;
           reasoning = Boolean(entry.thinkingLevels && entry.thinkingLevels.length > 0 && entry.thinkingLevels[0] !== "off");
           acceptsImages = 'acceptsImages' in entry ? Boolean(entry.acceptsImages) : false;
        }
      }

      const modelConfig: HermesConfigModel = {
        id: modelId,
        contextWindow,
        maxTokens,
        reasoning,
        acceptsImages,
        thinkingLevel,
      };

      const document = migrateHermesRuntimeConfig(input.runtimeConfig);
      const compiled = compileHermesRuntimeConfig(document, modelConfig);

      return {
        preview: compiled.preview as any,
      };
    }),
  }
});
