import type { ComposerActionId } from "@ardurbot/core";
import { t } from "@lingui/core/macro";
import { rpc } from "../../lib/rpc";

export async function runComposerAction(
  action: ComposerActionId,
  argument: string | undefined,
  context: {
    botId?: string;
    onRefresh: (botId: string) => Promise<unknown>;
    onStop: () => Promise<void>;
    onRoutines: () => void;
    onModel: () => void;
    onChatSettings: () => void;
    onSettings: (section: "general" | "usage") => void;
    onUsage: (usage: Awaited<ReturnType<typeof rpc.usage.summary>>) => void;
    onError: (message: string) => void;
  },
) {
  try {
    switch (action) {
      case "new":
        if (context.botId) {
          await rpc.threads.restart({ botId: context.botId });
          await context.onRefresh(context.botId);
        }
        return true;
      case "stop":
        await context.onStop();
        return true;
      case "remember":
        if (context.botId && argument)
          await rpc.memory.remember({
            botId: context.botId,
            text: argument,
            nonce: crypto.randomUUID(),
          });
        return true;
      case "routine":
        context.onRoutines();
        return true;
      case "model":
        context.onModel();
        return true;
      case "chat-settings":
        context.onChatSettings();
        return true;
      case "settings-usage":
        context.onSettings("usage");
        context.onUsage(await rpc.usage.summary());
        return true;
      case "settings":
      case "settings-general":
        context.onSettings("general");
        return true;
    }
    return true;
  } catch {
    context.onError(
      action === "new"
        ? t`Could not start a new chat`
        : action === "remember"
          ? t`Could not save memory`
          : t`Could not complete command. Try again.`,
    );
    return false;
  }
}
