// @vitest-environment jsdom
import type { EvidenceRunSummary } from "@ardurbot/contracts/evidence";
import type { EvidenceState } from "@ardurbot/contracts/evidence-states";
import { EVIDENCE_STATES } from "@ardurbot/contracts/evidence-states";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import RunEvidence, { EvidenceDownload, EvidenceStatus } from "./RunEvidence";

const api = vi.hoisted(() => ({ summary: vi.fn() }));
vi.mock("../lib/rpc", () => ({
  rpc: { evidence: { runSummary: api.summary } },
  selectedSpaceId: () => "space",
}));
vi.mock("@lingui/core/macro", () => ({
  msg: (value: TemplateStringsArray | { id: string; message: string }) =>
    Array.isArray(value) ? { id: value.join(""), message: value.join("") } : value,
}));
vi.mock("@lingui/react", () => ({
  useLingui: () => ({ i18n: { _: (descriptor: { message: string }) => descriptor.message } }),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@ardurbot/ui-web", () => ({
  DropdownMenuItem: ({ render, children }: { render: ReactNode; children: ReactNode }) => (
    <div data-download>
      {render}
      {children}
    </div>
  ),
}));
let node: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
function summary(
  state: EvidenceState,
  sealed = state === "verified" || state === "gap",
): EvidenceRunSummary {
  return {
    sessionId: "run",
    state,
    sealed,
    gapCount: 2,
    failureCodes: [],
    recordedAt: "2026-09-29T12:00:00Z",
    decisions: { allowed: 1, denied: 0, asked: 0, recorded: 1 },
    captureLevel: "decisions",
    evidence: null,
    gates: { spend: null, risks: [] },
  };
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.summary.mockReset();
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(() => root.unmount());
  node.remove();
  vi.unstubAllGlobals();
});
it.each(Object.keys(EVIDENCE_STATES) as EvidenceState[])(
  "renders the shared %s label, with nothing for off",
  async (state) => {
    await act(() => root.render(<EvidenceStatus summary={summary(state)} />));
    expect(node.textContent).toBe(state === "off" ? "" : EVIDENCE_STATES[state].labelMessageId);
    if (state === "gap") expect(node.querySelector("span")?.title).toContain("evidence gaps");
  },
);
it.each(Object.keys(EVIDENCE_STATES) as EvidenceState[])(
  "only offers a downloadable seal in state %s",
  async (state) => {
    await act(() => root.render(<EvidenceDownload summary={summary(state)} spaceId="space" />));
    expect(node.textContent?.includes("Download evidence")).toBe(
      ["verified", "gap"].includes(state),
    );
    if (summary(state).sealed)
      expect(node.querySelector("a")?.getAttribute("href")).toBe(
        "/api/evidence/runs/run?spaceId=space",
      );
  },
);
it("does not request summaries for offscreen messages; requests once visible", async () => {
  let intersect!: IntersectionObserverCallback;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        intersect = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  api.summary.mockResolvedValue(summary("verified"));
  await act(() => root.render(<RunEvidence runId="run" />));
  expect(api.summary).not.toHaveBeenCalled();
  await act(async () =>
    intersect(
      [{ isIntersecting: true }] as IntersectionObserverEntry[],
      {} as IntersectionObserver,
    ),
  );
  expect(api.summary).toHaveBeenCalledWith(
    { runId: "run" },
    expect.objectContaining({ context: { spaceId: "space" } }),
  );
  expect(node.textContent).toBe("Verified");
});
it.each([
  ["off", ""],
  ["verified", "Verified"],
  ["failed", "Check failed"],
] as const)("renders a fetched %s result without inventing a failed check", async (state, text) => {
  vi.stubGlobal("IntersectionObserver", undefined);
  api.summary.mockResolvedValue({
    ...summary(state),
    gapCount: 0,
    decisions: {
      allowed: state === "off" ? 0 : 3,
      denied: 0,
      asked: 0,
      recorded: state === "off" ? 0 : 3,
    },
    failureCodes: state === "failed" ? ["signature_invalid"] : [],
  });
  await act(async () => root.render(<RunEvidence runId="run" />));
  expect(node.textContent).toBe(text);
  if (state === "failed")
    expect(node.querySelector('[data-evidence-state="failed"]')?.getAttribute("title")).toBe(
      "signature_invalid",
    );
});

it("shows nothing when the summary lookup fails", async () => {
  vi.stubGlobal("IntersectionObserver", undefined);
  api.summary.mockRejectedValue(new Error("Lookup unavailable"));
  await act(async () => root.render(<RunEvidence runId="run" />));
  expect(node.textContent).toBe("");
});

it("fetches the current summary when its menu is opened", async () => {
  api.summary.mockResolvedValue(summary("verified"));
  await act(async () => root.render(<RunEvidence runId="run" action="download" />));
  expect(api.summary).toHaveBeenCalledTimes(1);
  expect(node.textContent).toContain("Download evidence");
});
it.each([
  ["an empty list", []],
  ["an unknown state", { ...summary("verified"), state: "unknown" }],
])("shows nothing and keeps rendering when the reply is %s", async (_name, reply) => {
  vi.stubGlobal("IntersectionObserver", undefined);
  api.summary.mockResolvedValue(reply);
  await act(async () =>
    root.render(
      <>
        <RunEvidence runId="run" />
        <RunEvidence runId="run" action="download" />
        <p>message text</p>
      </>,
    ),
  );
  expect(api.summary).toHaveBeenCalledTimes(2);
  expect(node.textContent).toBe("message text");
  vi.unstubAllGlobals();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
it("ignores an answer that arrives after unmounting instead of aborting the request", async () => {
  vi.stubGlobal("IntersectionObserver", undefined);
  let answer: (value: EvidenceRunSummary) => void = () => undefined;
  api.summary.mockReturnValue(new Promise((resolve) => (answer = resolve)));
  await act(async () => root.render(<RunEvidence runId="run" />));
  const [, options] = api.summary.mock.calls[0] as [unknown, { signal?: AbortSignal }];
  await act(async () => root.render(<p>message text</p>));
  await act(async () => answer(summary("verified")));
  expect(options.signal).toBeUndefined();
  expect(node.textContent).toBe("message text");
  vi.unstubAllGlobals();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
