import type { MessageReaction } from "@ardurbot/contracts";
import { Button, Input, Popover, PopoverContent, PopoverTrigger } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useState } from "react";

export type FeedbackEdit = { reason?: string; retract?: boolean };
export function MessageFeedback({
  onFeedback,
}: {
  onFeedback: (reaction: MessageReaction, edit?: FeedbackEdit) => Promise<void>;
}) {
  const { t } = useLingui();
  const [selected, setSelected] = useState<MessageReaction | null>(null);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  async function save(reaction: MessageReaction, retract = false) {
    setSaving(true);
    try {
      await onFeedback(reaction, { reason, retract });
      setSelected(null);
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      {(["👍", "👎"] as const).map((reaction) => (
        <Popover
          key={reaction}
          open={selected === reaction}
          onOpenChange={(open) => {
            setSelected(open ? reaction : null);
            if (open) setReason("");
          }}
        >
          <PopoverTrigger
            aria-label={reaction}
            className="grid h-9 w-9 place-items-center rounded-md hover:bg-accent"
            onClick={() => {
              void onFeedback(reaction);
            }}
          >
            {reaction}
          </PopoverTrigger>
          <PopoverContent
            className="w-72"
            aria-label={reaction === "👎" ? t`What was wrong?` : t`What was good?`}
          >
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void save(reaction);
              }}
            >
              <Input
                aria-label={reaction === "👎" ? t`What was wrong?` : t`What was good?`}
                placeholder={reaction === "👎" ? t`What was wrong?` : t`What was good?`}
                value={reason}
                maxLength={500}
                onChange={(event) => setReason(event.target.value.replace(/[\r\n]/g, " "))}
              />
              <div className="flex justify-between gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={saving}
                  onClick={() => void save(reaction, true)}
                >{t`Remove feedback`}</Button>
                <Button type="submit" disabled={saving}>{t`Save`}</Button>
              </div>
            </form>
          </PopoverContent>
        </Popover>
      ))}
    </>
  );
}
