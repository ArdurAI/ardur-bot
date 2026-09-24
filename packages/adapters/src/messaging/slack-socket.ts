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

export function slackEvent(envelope: unknown, botUserId?: string): ChatEvent | null {
  const frame = record(envelope);
  const payload = record(frame.payload);
  const event = record(payload.event);
  const interactive = payload.type === "block_actions";
  if (
    !interactive &&
    (event.bot_id || event.subtype || !["message", "app_mention"].includes(string(event.type)))
  )
    return null;
  const channel = interactive ? string(record(payload.channel).id) : string(event.channel);
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  const files = Array.isArray(event.files) ? event.files.map(record) : [];
  const parsed = ChatEventSchema.safeParse({
    provider: "slack",
    eventId: string(payload.event_id) || string(frame.envelope_id),
    workspaceId: string(payload.team_id ?? record(payload.team).id),
    senderId: interactive ? string(record(payload.user).id) : string(event.user),
    channelId: channel,
    messageId: string(interactive ? record(payload.message).ts : event.ts),
    private: event.channel_type === "im" || channel.startsWith("D"),
    addressed:
      interactive ||
      event.channel_type === "im" ||
      channel.startsWith("D") ||
      event.type === "app_mention" ||
      Boolean(event.thread_ts) ||
      (botUserId !== undefined && string(event.text).includes(`<@${botUserId}>`)),
    text: string(event.text),
    threadId: string(event.thread_ts ?? record(payload.message).thread_ts) || undefined,
    replyTo: string(event.thread_ts) || undefined,
    action: interactive ? string(record(actions[0]).value) : undefined,
    attachmentCount: files.length,
    attachmentBytes: files.reduce((sum, file) => sum + Number(file.size ?? 0), 0),
  });
  return parsed.success ? parsed.data : null;
}
export function slackSocketTransport(
  config: ChatCredentials,
  io: TransportIO = transportIO,
): ChatTransport {
  const call = (method: string, body: unknown, signal: AbortSignal, app = false) =>
    request(
      io,
      `https://slack.com/api/${method}`,
      `Bearer ${app ? config.appToken : config.botToken}`,
      body,
      signal,
    );
  return {
    async verify(signal) {
      const result = await call("auth.test", {}, signal);
      if (!string(result.user_id) || !string(result.team_id))
        throw new Error("Could not verify this bot.");
      const socket = await call("apps.connections.open", {}, signal, true);
      if (!string(socket.url).startsWith("wss://"))
        throw new Error("Could not verify Socket Mode.");
      return {
        accountId: `${string(result.team_id)}:${string(result.user_id)}`,
        workspaceId: string(result.team_id),
      };
    },
    async receive(context) {
      const opened = await call("apps.connections.open", {}, context.signal, true);
      const url = string(opened.url);
      if (!/^wss:\/\/[a-z0-9.-]+\.slack\.com\//.test(url))
        throw new Error("Invalid socket address.");
      await socketSession(io, url, context.signal, async (frame, socket) => {
        if (frame.type === "disconnect") {
          socket.close();
          return;
        }
        if (!string(frame.envelope_id)) return;
        const event = slackEvent(frame, config.accountId?.split(":")[1]);
        if (event) {
          const files = record(record(frame.payload).event).files;
          const sources = (Array.isArray(files) ? files : []).map(record).map((file) => ({
            name: string(file.name),
            type: string(file.mimetype),
            size: Number(file.size ?? 0),
            open: () =>
              fetchChatFile(
                io,
                string(file.url_private_download ?? file.url_private),
                ["files.slack.com"],
                context.signal,
                config.botToken,
              ),
          }));
          await context.accept(await readChatAttachments(event, sources));
        }
        // ACK only after durable receipt; retries use payload.event_id, not envelope delivery id.
        socket.send(JSON.stringify({ envelope_id: frame.envelope_id }));
      });
    },
    async send(destination, card, signal, checkpoint) {
      let first = checkpoint?.firstMessageId ?? "";
      for (const [index, text] of chatChunks(card.text, 3000).entries()) {
        if (index < (checkpoint?.sentChunks ?? 0)) continue;
        const result = await call(
          "chat.postMessage",
          {
            channel: destination.channelId,
            thread_ts: destination.threadId,
            text,
            unfurl_links: false,
            unfurl_media: false,
            blocks: [
              { type: "section", text: { type: "plain_text", text } },
              ...(index === 0 && card.actions
                ? [
                    {
                      type: "actions",
                      elements: card.actions.map((action, i) => ({
                        type: "button",
                        text: { type: "plain_text", text: action.label },
                        action_id: `dispatch_${i}`,
                        value: action.value,
                      })),
                    },
                  ]
                : []),
            ],
          },
          signal,
        );
        const messageId = string(result.ts);
        if (!messageId) throw new ProviderResponseError(0);
        first ||= messageId;
        await checkpoint?.sent(index, messageId);
      }
      return first;
    },
  };
}
