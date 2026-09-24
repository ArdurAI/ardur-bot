import type { ChatEvent } from "@ardurbot/contracts";
import { ChatEventSchema } from "@ardurbot/contracts";
import { fetchChatFile, readChatAttachments } from "./attachments.js";
import type { ChatCredentials, ChatTransport, TransportIO } from "./transport.js";
import {
  chatChunks,
  ProviderResponseError,
  record,
  request,
  string,
  transportIO,
} from "./transport.js";

export function telegramEvent(payload: unknown): ChatEvent | null {
  const update = record(payload);
  const callback = record(update.callback_query);
  const message = record(update.message ?? callback.message);
  const sender = record(callback.from ?? message.from);
  const chat = record(message.chat);
  if (sender.is_bot || !string(sender.id) || !string(chat.id) || !string(update.update_id))
    return null;
  const attachments = [
    message.document,
    message.video,
    message.audio,
    message.voice,
    ...(Array.isArray(message.photo) ? message.photo.slice(-1) : []),
  ]
    .filter(Boolean)
    .map(record);
  const result = ChatEventSchema.safeParse({
    provider: "telegram",
    eventId: string(update.update_id),
    workspaceId: "telegram",
    senderId: string(sender.id),
    channelId: string(chat.id),
    messageId: string(message.message_id),
    private: chat.type === "private",
    addressed:
      chat.type === "private" ||
      Boolean(callback.id) ||
      record(record(message.reply_to_message).from).is_bot === true ||
      (Array.isArray(message.entities) &&
        message.entities.some((entity) =>
          ["mention", "text_mention", "bot_command"].includes(string(record(entity).type)),
        )),
    text: string(message.text ?? message.caption),
    replyTo: string(record(message.reply_to_message).message_id) || undefined,
    threadId: string(message.message_thread_id) || undefined,
    action: string(callback.data) || undefined,
    attachmentCount: attachments.length,
    attachmentBytes: attachments.reduce((sum, item) => sum + Number(item.file_size ?? 0), 0),
  });
  return result.success ? result.data : null;
}
function markdown(text: string) {
  const escapeText = (value: string) => value.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
  // chunkUnicode closes/reopens fenced blocks. Preserve those fences while escaping
  // code content under Telegram's separate preformatted-text rules.
  return text
    .split(/(```[^\n`]*\n[\s\S]*?```)/g)
    .map((part) => {
      const code = /^```([^\n`]*)\n([\s\S]*?)```$/.exec(part);
      if (!code) return escapeText(part);
      const language = /^[\w+-]*$/.test(code[1]!) ? code[1] : "";
      return `\`\`\`${language}\n${code[2]!.replace(/[\\`]/g, "\\$&")}\`\`\``;
    })
    .join("");
}
export function telegramTransport(
  config: ChatCredentials,
  io: TransportIO = transportIO,
): ChatTransport {
  const call = (method: string, body: unknown, signal: AbortSignal) =>
    request(
      io,
      `https://api.telegram.org/bot${config.botToken}/${method}`,
      undefined,
      body,
      signal,
    );
  return {
    async verify(signal) {
      const me = record((await call("getMe", {}, signal)).result);
      if (!string(me.id)) throw new Error("Could not verify this bot.");
      return { accountId: string(me.id), workspaceId: "telegram" };
    },
    async receive(context) {
      const info = record((await call("getWebhookInfo", {}, context.signal)).result);
      if (info.url || config.webhookUrl) return;
      let offset = Number((await context.load()).offset ?? 0);
      while (!context.signal.aborted) {
        const result = await call(
          "getUpdates",
          { offset, timeout: 25, limit: 50, allowed_updates: ["message", "callback_query"] },
          context.signal,
        );
        if (!Array.isArray(result.result)) throw new Error("Invalid chat response.");
        for (const update of result.result) {
          const id = Number(record(update).update_id);
          if (!Number.isSafeInteger(id) || id < offset) continue;
          const event = telegramEvent(update);
          if (event) {
            const document = record(record(record(update).message).document);
            const sources = document.file_id
              ? [
                  {
                    name: string(document.file_name),
                    type: string(document.mime_type),
                    size: Number(document.file_size ?? 0),
                    open: async () => {
                      const file = record(
                        (await call("getFile", { file_id: document.file_id }, context.signal))
                          .result,
                      );
                      const path = string(file.file_path);
                      if (!path || path.split("/").includes(".."))
                        throw new Error("Invalid attachment path.");
                      return fetchChatFile(
                        io,
                        `https://api.telegram.org/file/bot${config.botToken}/${path.split("/").map(encodeURIComponent).join("/")}`,
                        ["api.telegram.org"],
                        context.signal,
                      );
                    },
                  },
                ]
              : [];
            await context.accept(await readChatAttachments(event, sources));
          }
          offset = id + 1;
          await context.save({ offset });
          const callbackId = string(record(record(update).callback_query).id);
          if (callbackId)
            await call("answerCallbackQuery", { callback_query_id: callbackId }, context.signal);
        }
      }
    },
    async send(destination, card, signal, checkpoint) {
      let first = checkpoint?.firstMessageId ?? "";
      // Escaping can double the wire length; Telegram counts the parsed text.
      for (const [index, chunk] of chatChunks(card.text, 4096).entries()) {
        if (index < (checkpoint?.sentChunks ?? 0)) continue;
        const body = {
          chat_id: destination.channelId,
          ...(destination.threadId ? { message_thread_id: Number(destination.threadId) } : {}),
          ...(index === 0 && card.actions
            ? {
                reply_markup: {
                  inline_keyboard: [
                    card.actions.map((action) => ({
                      text: action.label,
                      callback_data: action.value,
                    })),
                  ],
                },
              }
            : {}),
        };
        let result: Record<string, unknown>;
        try {
          result = await call(
            "sendMessage",
            { ...body, text: markdown(chunk), parse_mode: "MarkdownV2" },
            signal,
          );
        } catch (error) {
          if (!(error instanceof ProviderResponseError) || !error.formatting) throw error;
          result = await call("sendMessage", { ...body, text: chunk }, signal);
        }
        const messageId = string(record(result.result).message_id);
        if (!messageId) throw new ProviderResponseError(0);
        first ||= messageId;
        await checkpoint?.sent(index, messageId);
      }
      return first;
    },
  };
}
