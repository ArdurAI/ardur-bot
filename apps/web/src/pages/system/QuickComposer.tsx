import type { Bot, Me } from "@ardurbot/contracts";
import { Button, NativeSelect, NativeSelectOption } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import { rpc, selectedSpaceId } from "../../lib/rpc";
import { systemBridge } from "./bridge";

export function QuickComposer({ signedIn }: { signedIn: boolean }) {
  const { t } = useLingui();
  const bridge = systemBridge();
  const [bots, setBots] = useState<Bot[]>([]);
  const [identity, setIdentity] = useState<Me | null>(null);
  const [botId, setBotId] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nonce = useRef(crypto.randomUUID());
  const text = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!signedIn || !bridge?.quickBot) return;
    let active = true;
    const spaceId = selectedSpaceId();
    void Promise.all([
      rpc.me(undefined, { context: { spaceId } }),
      rpc.bots.list(undefined, { context: { spaceId } }),
    ])
      .then(async ([me, available]) => {
        const saved = await bridge.quickBot!(me);
        if (!active) return;
        setIdentity(me);
        setBots(available);
        setBotId(available.some((bot) => bot.id === saved) ? saved! : "");
        text.current?.focus();
      })
      .catch(() => {
        if (active) setError(t`Could not load your bots; reopen quick access.`);
      });
    return () => {
      active = false;
    };
  }, [bridge, signedIn, t]);
  async function send() {
    if (!identity || !botId || !draft.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await bridge?.quickBot?.(identity, botId);
      await rpc.threads.send(
        { botId, text: draft.trim(), clientNonce: nonce.current },
        { context: { spaceId: identity.spaceId } },
      );
      setDraft("");
      nonce.current = crypto.randomUUID();
      await bridge?.closeQuick?.();
    } catch {
      setError(t`Could not send your message; try again.`);
    } finally {
      setBusy(false);
    }
  }
  if (!bridge?.quickBot) return null;
  return (
    <main className="flex h-full flex-col gap-3 bg-background p-4 text-foreground">
      {!signedIn ? (
        <>
          <p className="text-sm">{t`Sign in to use quick access.`}</p>
          <Button onClick={() => void bridge.openMain?.()}>{t`Open Ardur Bot`}</Button>
        </>
      ) : (
        <>
          <NativeSelect
            aria-label={t`Coordinator bot`}
            value={botId}
            disabled={busy}
            onChange={(event) => {
              setBotId(event.target.value);
              nonce.current = crypto.randomUUID();
            }}
          >
            <NativeSelectOption value="">{t`Choose a bot`}</NativeSelectOption>
            {bots.map((bot) => (
              <NativeSelectOption key={bot.id} value={bot.id}>
                {bot.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <textarea
            ref={text}
            aria-label={t`Message`}
            placeholder={t`Message…`}
            value={draft}
            disabled={busy}
            className="min-h-16 flex-1 resize-none rounded-md border border-border bg-background p-2 text-sm"
            onChange={(event) => {
              setDraft(event.target.value);
              nonce.current = crypto.randomUUID();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className="flex justify-end">
            <Button
              disabled={busy || !botId || !draft.trim()}
              onClick={() => void send()}
            >{t`Send`}</Button>
          </div>
        </>
      )}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </main>
  );
}
