// @vitest-environment jsdom
import type { ThreadSnapshot } from "@ardurbot/contracts";
import { SEAL_DONE_MS } from "@ardurbot/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useThreadSealPhases } from "./seal-phase";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const empty: ThreadSnapshot = {
  threadId: "thread",
  cursor: 1,
  olderCursor: null,
  messages: [],
  run: null,
};
const seen = new Set<string>();

function Phase({ completedAt }: { completedAt: ReadonlyMap<string, number> }) {
  const phases = useThreadSealPhases(empty, completedAt, seen);
  return <span>{phases.get("scout")?.phase ?? "idle"}</span>;
}

it("lets done give way to rest without another render from the shell", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ now: Date.parse("2026-09-28T12:00:00.000Z") });
  const host = document.createElement("div");
  const root = createRoot(host);
  const completedAt = new Map([["scout", Date.now()]]);
  await act(async () => root.render(<Phase completedAt={completedAt} />));
  expect(host.textContent).toBe("done");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SEAL_DONE_MS - 1);
  });
  expect(host.textContent).toBe("done");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(host.textContent).toBe("idle");
  await act(async () => root.unmount());
});
