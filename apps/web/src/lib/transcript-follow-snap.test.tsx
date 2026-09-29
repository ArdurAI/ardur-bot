// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useTranscriptFollowSnap } from "./transcript-scroll";

function Harness({
  messages,
  quoteOpen,
  snapToEnd,
}: {
  messages: string;
  quoteOpen: boolean;
  snapToEnd: () => void;
}) {
  const following = useRef(true);
  useTranscriptFollowSnap({
    messages,
    running: true,
    quoteOpen,
    following,
    snapToEnd,
  });
  return null;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("holds the transcript while a quote is open and follows again when the quote closes", async () => {
  const snapToEnd = vi.fn();
  await act(async () =>
    root.render(<Harness messages="a" quoteOpen={false} snapToEnd={snapToEnd} />),
  );
  expect(snapToEnd).toHaveBeenCalledTimes(1);

  await act(async () =>
    root.render(<Harness messages="b" quoteOpen={true} snapToEnd={snapToEnd} />),
  );
  expect(snapToEnd).toHaveBeenCalledTimes(1);

  await act(async () =>
    root.render(<Harness messages="b" quoteOpen={false} snapToEnd={snapToEnd} />),
  );
  expect(snapToEnd).toHaveBeenCalledTimes(2);
});
