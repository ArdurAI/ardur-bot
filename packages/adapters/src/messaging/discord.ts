import type { ChatEvent } from "@ardurbot/contracts";
import { ChatEventSchema } from "@ardurbot/contracts";
import { fetchChatFile, readChatAttachments } from "./attachments.js";
import type { ChatCredentials, ChatTransport, TransportIO } from "./transport.js";
import {
  chatChunks,
  ProviderResponseError,
  record,
  request,
  socketSession,
  string,
  transportIO,
} from "./transport.js";

export function discordEvent(payload: unknown, botUserId?: string): ChatEvent | null {
  const frame = record(payload);
  const data = record(frame.d);
  if (frame.t !== "MESSAGE_CREATE" && frame.t !== "INTERACTION_CREATE") return null;
  const interaction = frame.t === "INTERACTION_CREATE";
  if (interaction && data.type !== 3) return null;
  const author = record(data.author ?? record(data.member).user ?? data.user);
  if (author.bot || data.webhook_id || !string(author.id)) return null;
  const attachments = Array.isArray(data.attachments) ? data.attachments.map(record) : [];
  const parsed = ChatEventSchema.safeParse({
    provider: "discord",
    eventId: string(data.id),
    workspaceId: string(data.guild_id) || "@direct",
    senderId: string(author.id),
    channelId: string(data.channel_id),
    messageId: string(interaction ? record(data.message).id : data.id),
    private: !data.guild_id,
    addressed:
      !data.guild_id ||
      interaction ||
      (Array.isArray(data.mentions) &&
        data.mentions.some((mention) => string(record(mention).id) === botUserId)) ||
      (botUserId !== undefined &&
        string(record(record(data.referenced_message).author).id) === botUserId),
    text: string(data.content),
    replyTo: string(record(data.message_reference).message_id) || undefined,
    action: interaction ? string(record(data.data).custom_id) : undefined,
    attachmentCount: attachments.length,
    attachmentBytes: attachments.reduce((sum, item) => sum + Number(item.size ?? 0), 0),
  });
  return parsed.success ? parsed.data : null;
}
export function discordTransport(
  config: ChatCredentials,
  io: TransportIO = transportIO,
): ChatTransport {
  const api = "https://discord.com/api/v10";
  return {
    async verify(signal) {
      const response = await io.fetch(`${api}/users/@me`, {
        headers: { authorization: `Bot ${config.botToken}` },
        signal,
      });
      const me = record(await response.json());
      if (!response.ok || !me.bot || !string(me.id)) throw new Error("Could not verify this bot.");
      return { accountId: string(me.id) };
    },
    async receive(context) {
      let state = await context.load();
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let firstHeartbeat: ReturnType<typeof setTimeout> | undefined;
      let acknowledged = true;
      const gateway =
        typeof state.resumeUrl === "string" &&
        /^wss:\/\/[a-z0-9.-]+\.discord\.gg\/?$/.test(state.resumeUrl)
          ? state.resumeUrl
          : "wss://gateway.discord.gg";
      try {
        await socketSession(
          io,
          `${gateway.replace(/\/$/, "")}/?v=10&encoding=json`,
          context.signal,
          async (frame, socket) => {
            const send = (op: number, d: unknown) => socket.send(JSON.stringify({ op, d }));
            if (frame.op === 10) {
              const interval = Number(record(frame.d).heartbeat_interval);
              if (!Number.isFinite(interval) || interval < 1000)
                throw new Error("Invalid heartbeat.");
              const beat = () => {
                if (context.signal.aborted || socket.readyState !== 1) return;
                if (!acknowledged) {
                  socket.close(4000);
                  return;
                }
                acknowledged = false;
                send(1, state.sequence ?? null);
              };
              firstHeartbeat = setTimeout(() => {
                beat();
                heartbeat = setInterval(beat, interval);
              }, interval * Math.random());
              send(
                state.sessionId ? 6 : 2,
                state.sessionId
                  ? {
                      token: config.botToken,
                      session_id: state.sessionId,
                      seq: state.sequence ?? null,
                    }
                  : {
                      token: config.botToken,
                      intents: 1 | 512 | 4096 | 32768,
                      properties: { os: "linux", browser: "ardurbot", device: "ardurbot" },
                    },
              );
            } else if (frame.op === 11) acknowledged = true;
            else if (frame.op === 1) send(1, state.sequence ?? null);
            else if (frame.op === 7) socket.close(4000);
            else if (frame.op === 9) {
              if (frame.d !== true) {
                state = {};
                await context.save(state);
              }
              socket.close(4000);
            } else if (frame.op === 0) {
              if (frame.t === "READY") {
                const data = record(frame.d);
                state = {
                  ...state,
                  sessionId: string(data.session_id),
                  resumeUrl: string(data.resume_gateway_url),
                };
              }
              const event = discordEvent(frame, config.accountId);
              if (event) {
                const files = record(frame.d).attachments;
                const sources = (Array.isArray(files) ? files : []).map(record).map((file) => ({
                  name: string(file.filename),
                  type: string(file.content_type).split(";")[0]!,
                  size: Number(file.size ?? 0),
                  open: () =>
                    fetchChatFile(
                      io,
                      string(file.url),
                      ["cdn.discordapp.com", "media.discordapp.net"],
                      context.signal,
                    ),
                }));
                await context.accept(await readChatAttachments(event, sources));
              }
              // Resume only past events committed to the inbox.
              if (typeof frame.s === "number") state.sequence = frame.s;
              await context.save(state);
              if (event?.action) {
                const data = record(frame.d);
                await request(
                  io,
                  `${api}/interactions/${string(data.id)}/${string(data.token)}/callback`,
                  undefined,
                  { type: 6 },
                  context.signal,
                );
              }
            }
          },
          undefined,
          async (code) => {
            if ([4003, 4004, 4005, 4007, 4009].includes(code)) {
              state = {};
              await context.save(state);
            }
          },
        );
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        if (firstHeartbeat) clearTimeout(firstHeartbeat);
      }
    },
    async send(destination, card, signal, checkpoint) {
      let first = checkpoint?.firstMessageId ?? "";
      for (const [index, content] of chatChunks(card.text, 2000).entries()) {
        if (index < (checkpoint?.sentChunks ?? 0)) continue;
        const sent = await request(
          io,
          `${api}/channels/${encodeURIComponent(destination.channelId)}/messages`,
          `Bot ${config.botToken}`,
          {
            content,
            allowed_mentions: { parse: [] },
            ...(index === 0 && card.actions
              ? {
                  components: [
                    {
                      type: 1,
                      components: card.actions.map((action) => ({
                        type: 2,
                        style: 2,
                        label: action.label,
                        custom_id: action.value,
                      })),
                    },
                  ],
                }
              : {}),
          },
          signal,
        );
        const messageId = string(sent.id);
        if (!messageId) throw new ProviderResponseError(0);
        first ||= messageId;
        await checkpoint?.sent(index, messageId);
      }
      return first;
    },
  };
}
