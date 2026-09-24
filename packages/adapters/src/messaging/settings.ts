import { randomUUID } from "node:crypto";
import type { AdapterContext } from "@ardurbot/adapter-kit";
import type { ChatInstallationInput } from "@ardurbot/contracts";
import { ChatInstallationInputSchema } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { DeviceRequestError } from "@ardurbot/db";
import { createChatTransport } from "../messaging-platforms.js";
import type { EncryptedSecretStore } from "../secrets.js";

export class MessagingInstallationSettings {
  private readonly cache = new Map<string, { ciphertext: string; config: ChatInstallationInput }>();
  constructor(
    private readonly prisma: PrismaClient,
    private readonly secrets: EncryptedSecretStore,
  ) {}
  load(row: { id: string; ciphertext: string }) {
    const cached = this.cache.get(row.id);
    if (cached?.ciphertext === row.ciphertext) return cached.config;
    const config = ChatInstallationInputSchema.parse(
      JSON.parse(this.secrets.load(row.ciphertext, `chat-installation:${row.id}`)),
    );
    this.cache.set(row.id, { ciphertext: row.ciphertext, config });
    return config;
  }
  async save(input: ChatInstallationInput, context: AdapterContext) {
    const config = ChatInstallationInputSchema.parse(input);
    const home = await this.prisma.instanceIdentity.findUniqueOrThrow({ where: { id: "home" } });
    const bot = await this.prisma.bot.findFirst({
      where: {
        id: config.botId,
        userId: context.userId,
        spaceId: context.spaceId,
        archivedAt: null,
      },
    });
    if (!bot) throw new DeviceRequestError("Choose an available bot.");
    let verified: { accountId: string; workspaceId?: string };
    try {
      verified = await createChatTransport(config).verify(context.signal);
    } catch {
      throw new DeviceRequestError("Could not verify this bot. Check its credentials in Settings.");
    }
    if (verified.workspaceId && verified.workspaceId !== config.workspaceId)
      throw new DeviceRequestError("This bot belongs to another workspace.");
    const existing = await this.prisma.chatInstallation.findUnique({
      where: { provider_accountId: { provider: config.provider, accountId: verified.accountId } },
    });
    if (
      existing &&
      (existing.userId !== context.userId ||
        existing.spaceId !== context.spaceId ||
        existing.workspaceId !== config.workspaceId)
    )
      throw new DeviceRequestError("This bot is already connected to another space or workspace.");
    const id = existing?.id ?? randomUUID();
    const secret = await this.secrets.put(
      JSON.stringify(config),
      context,
      `chat-installation:${id}`,
    );
    await this.prisma.chatInstallation.upsert({
      where: { id },
      create: {
        id,
        instanceId: home.instanceId,
        userId: context.userId,
        spaceId: context.spaceId,
        provider: config.provider,
        accountId: verified.accountId,
        workspaceId: config.workspaceId,
        botId: config.botId,
        ciphertext: secret.ciphertext,
      },
      update: {
        botId: config.botId,
        ciphertext: secret.ciphertext,
        enabled: true,
        revision: { increment: 1 },
      },
    });
    return { id };
  }
}
