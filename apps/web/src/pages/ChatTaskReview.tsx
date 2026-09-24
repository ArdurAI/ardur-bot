import type { RunActivityRow, ThreadSnapshot } from "@ardurbot/contracts";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { AskCard } from "../components/AskCard";
import { rpc } from "../lib/rpc";

/** Owner review of a room's isolated transcript. Answers use the existing thread transaction. */
export function ChatTaskReview({ run, onClose }: { run: RunActivityRow; onClose: () => void }) {
  const { t } = useLingui();
  const [snapshot, setSnapshot] = useState<ThreadSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      try {
        const value = await rpc.threads.get({ botId: run.botId, threadId: run.threadId });
        if (!closed) {
          setSnapshot(value);
          setFailed(false);
        }
      } catch {
        if (!closed) setFailed(true);
      }
      if (!closed) timer = setTimeout(() => void refresh(), 5_000);
    }
    void refresh();
    return () => {
      closed = true;
      clearTimeout(timer);
    };
  }, [run.botId, run.threadId]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent aria-describedby={undefined} data-testid="chat-task-review">
        <DialogHeader>
          <DialogTitle>{run.botName}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[70vh] space-y-3 overflow-auto">
          {failed ? <p role="alert">{t`Reconnect to your home.`}</p> : null}
          {snapshot?.messages.map((message) => (
            <div key={message.id} className="space-y-2">
              {message.blocks.map((block, index) =>
                block.kind === "text" ? (
                  <p
                    key={`${message.id}:${index}`}
                    className="whitespace-pre-wrap break-words text-sm"
                  >
                    {block.text}
                  </p>
                ) : block.kind === "ask" ? (
                  <AskCard
                    key={`${message.id}:${index}`}
                    block={block}
                    canAnswer={
                      snapshot.run?.id === message.runId &&
                      snapshot.run?.status === "waiting_input" &&
                      block.status !== "answered"
                    }
                    onAnswer={async (answer) => {
                      if (!message.runId) return;
                      await rpc.threads.answer({
                        botId: run.botId,
                        threadId: run.threadId,
                        runId: message.runId,
                        messageId: message.id,
                        answer,
                      });
                      setSnapshot(
                        await rpc.threads.get({ botId: run.botId, threadId: run.threadId }),
                      );
                    }}
                  />
                ) : null,
              )}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
