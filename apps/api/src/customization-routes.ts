import { McpOAuthBroker } from "@ardurbot/adapters";
import type { Actor } from "@ardurbot/contracts";
import { customizationContract } from "@ardurbot/contracts";
import type { Router } from "@orpc/server";
import { implement, ORPCError } from "@orpc/server";
import { readBundleZip } from "../../desktop/src/extensions/zip.js";
import { uploadedBundle } from "./customization-files.js";
import { createCustomizationPlugins } from "./customization-plugins.js";
import { createCustomizationSkills, customizationCatalog } from "./customization-skills.js";
import { createMcpSettings } from "./mcp-settings.js";
import type { RouterDeps } from "./router.js";

export type RouterContext = {
  actor: Actor | null;
  signal?: AbortSignal;
  authSessionId?: string;
  origin?: string;
};
export function createCustomizationRoutes(
  deps: RouterDeps,
): Router<typeof customizationContract, RouterContext> {
  const base = implement(customizationContract).$context<RouterContext>();
  const authed = base.use(async ({ context, next }) => {
    if (!context.actor) throw new ORPCError("UNAUTHORIZED");
    return next({ context: { ...context, actor: context.actor } });
  });
  const mcp = createMcpSettings(deps);
  const skills = createCustomizationSkills(deps);
  const plugins = createCustomizationPlugins(deps);
  const oauth = deps.mcpOAuth ?? new McpOAuthBroker(deps.prisma, deps.secrets);
  return base.router({
    connectors: {
      summary: authed.connectors.summary.handler(async ({ context }) => {
        const rows = await deps.prisma.mcpServer.findMany({
          where: { spaceId: context.actor.spaceId, userId: context.actor.userId, enabled: true },
        });
        let needingReconnection = 0;
        for (const row of rows)
          if (
            row.connectionState === "discovery-failed" ||
            (await oauth.statusFor(row, context.actor)) === "reconnect"
          )
            needingReconnection++;
        return { needingReconnection };
      }),
    },
    developer: {
      list: authed.developer.list.handler(({ context }) => mcp.list(context.actor)),
      logs: authed.developer.logs.handler(({ context, input }) =>
        mcp.logs(context.actor, input.serverId),
      ),
      config: authed.developer.config.handler(({ context }) => mcp.config(context.actor)),
      preview: authed.developer.preview.handler(({ context, input }) =>
        mcp.preview(context.actor, input),
      ),
      apply: authed.developer.apply.handler(({ context, input }) =>
        mcp.apply(context.actor, input.previewId, input.placement),
      ),
    },
    extensions: {
      context: authed.extensions.context.handler(({ context }) => ({
        userId: context.actor.userId,
        spaceId: context.actor.spaceId,
      })),
      register: authed.extensions.register.handler(({ context, input }) =>
        mcp.register(context.actor, input),
      ),
      remove: authed.extensions.remove.handler(({ context, input }) =>
        mcp.removeManaged(context.actor, input),
      ),
    },
    customizationSkills: {
      list: authed.customizationSkills.list.handler(({ context }) => skills.list(context.actor)),
      get: authed.customizationSkills.get.handler(({ context, input }) =>
        skills.get(context.actor, input),
      ),
      setEnabled: authed.customizationSkills.setEnabled.handler(({ context, input }) =>
        skills.setEnabled(context.actor, input),
      ),
      remove: authed.customizationSkills.remove.handler(({ context, input }) =>
        skills.remove(context.actor, input),
      ),
      import: authed.customizationSkills.import.handler(({ context, input }) =>
        skills.import(
          context.actor,
          input.files
            ? uploadedBundle(input.files)
            : readBundleZip(Buffer.from(input.zip!, "base64")),
        ),
      ),
      catalog: authed.customizationSkills.catalog.handler(() => customizationCatalog),
    },
    plugins: {
      list: authed.plugins.list.handler(({ context }) => plugins.list(context.actor)),
      addMarketplace: authed.plugins.addMarketplace.handler(({ context, input }) =>
        plugins.addMarketplace(context.actor, {
          url: input.url,
          files: input.files ? uploadedBundle(input.files) : undefined,
        }),
      ),
      removeMarketplace: authed.plugins.removeMarketplace.handler(({ context, input }) =>
        plugins.removeMarketplace(context.actor, input.id),
      ),
      preview: authed.plugins.preview.handler(({ context, input }) =>
        plugins.preview(context.actor, input),
      ),
      files: authed.plugins.files.handler(({ context, input }) =>
        plugins.files(context.actor, input.previewId),
      ),
      install: authed.plugins.install.handler(({ context, input }) =>
        plugins.install(
          context.actor,
          input.previewId,
          input.nativeRoot,
          input.placement,
          input.installationId,
        ),
      ),
      uninstall: authed.plugins.uninstall.handler(({ context, input }) =>
        plugins.uninstall(context.actor, input.id),
      ),
    },
  });
}
