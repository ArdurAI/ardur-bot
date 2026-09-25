import { useLingui } from "@lingui/react/macro";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useEffect, useState } from "react";
import { dictation } from "../../lib/dictation";
import { rpc } from "../../lib/rpc";
import { systemBridge } from "./bridge";

/** Both native shortcuts feed the same draft and microphone engine as chat voice. */
export function SystemDictation({
  textarea,
  setDraft,
}: {
  textarea: RefObject<HTMLTextAreaElement | null>;
  setDraft: Dispatch<SetStateAction<string>>;
}) {
  const { t } = useLingui();
  const [status, setStatus] = useState("");
  useEffect(() => {
    const bridge = systemBridge();
    if (!bridge?.onShortcut) return;
    let mounted = true,
      ownsInput = false,
      starting = false;
    const unsubscribe = dictation.subscribe((snapshot) => {
      if (!ownsInput || !mounted) return;
      setStatus(
        snapshot.error
          ? t`Could not start dictation; check Voice settings.`
          : snapshot.status === "listening"
            ? t`Listening…`
            : snapshot.status === "transcribing"
              ? t`Transcribing…`
              : "",
      );
      if (snapshot.status === "idle" && !starting) ownsInput = false;
    });
    const off = bridge.onShortcut((action) => {
      if (starting) return;
      if (ownsInput) {
        dictation.submitHold();
        return;
      }
      const input = textarea.current;
      if (
        !input ||
        input.disabled ||
        dictation.state.status !== "idle" ||
        (action === "dictation" && document.activeElement !== input)
      )
        return;
      input.focus();
      starting = true;
      void rpc.voice
        .status()
        .then(async (voice) => {
          if (
            !mounted ||
            input !== textarea.current ||
            input.disabled ||
            document.visibilityState === "hidden"
          )
            return;
          // Never interrupt a voice call that started while the capability request was pending.
          if (dictation.state.status !== "idle") return;
          ownsInput = true;
          await dictation.listen({
            mode: "hold",
            transcribe: voice.transcribe,
            onFinal: (value) => {
              if (mounted) setDraft((draft) => (draft ? `${draft} ${value}` : value));
            },
          });
        })
        .catch(() => {
          if (mounted) setStatus(t`Could not start dictation; check Voice settings.`);
        })
        .finally(() => {
          starting = false;
          if (dictation.state.status === "idle") ownsInput = false;
        });
    });
    const onVisibility = () => {
      if (document.visibilityState === "hidden" && ownsInput) {
        dictation.stop("cancel");
        ownsInput = false;
        setStatus("");
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      mounted = false;
      off();
      unsubscribe();
      if (ownsInput) dictation.stop("cancel");
    };
  }, [setDraft, t, textarea]);
  return status ? (
    <p role="status" className="mb-2 text-sm text-muted-foreground">
      {status}
    </p>
  ) : null;
}
