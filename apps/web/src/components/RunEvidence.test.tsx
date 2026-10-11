// @vitest-environment jsdom
import type { EvidenceRunSummary } from "@ardurbot/contracts/evidence";
import type { EvidenceState } from "@ardurbot/contracts/evidence-states";
import { EVIDENCE_STATES } from "@ardurbot/contracts/evidence-states";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import RunEvidence, {
  EvidenceDownload,
  EvidenceIdentityDetails,
  EvidenceStatus,
} from "./RunEvidence";

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
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) => (open ? children : null),
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
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

const fingerprint = `sha256:${"a".repeat(64)}`;
async function openIdentity() {
  await act(() =>
    root.render(
      <EvidenceIdentityDetails
        summary={{
          ...summary("verified"),
          signingIdentity: { fingerprint, scope: { type: "space", id: "space" }, keyVersion: 1 },
          signerMatch: "no_expected_key",
        }}
        spaceId="space"
      />,
    ),
  );
  await act(() => node.querySelector("button")!.click());
}
function button(label: string) {
  return [...node.querySelectorAll("button")].find((item) => item.textContent === label)!;
}
async function enter(value: string) {
  await act(() => {
    const input = node.querySelector("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("reveals a public identity, copies its complete fingerprint, and exports a separate card", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const create = vi.fn().mockReturnValue("blob:identity");
  const revoke = vi.fn();
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    expect(this.download).toBe("ardur-signing-identity.json");
  });
  await openIdentity();
  expect(node.textContent).toContain(fingerprint);
  expect(node.textContent).toContain("Key version1");
  await act(() => button("Copy fingerprint").click());
  expect(writeText).toHaveBeenCalledWith(fingerprint);
  await act(() => button("Export identity card").click());
  expect(create).toHaveBeenCalledWith(expect.any(Blob));
  expect(click).toHaveBeenCalledOnce();
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(revoke).toHaveBeenCalledWith("blob:identity");
  click.mockRestore();
});
it.each(["expected_key", "different_key", "no_expected_key"] as const)(
  "shows the backend's %s comparison and sends the expected fingerprint",
  async (signerMatch) => {
    await openIdentity();
    const expected = signerMatch === "no_expected_key" ? "" : fingerprint;
    await enter(expected);
    api.summary.mockResolvedValue({ ...summary("verified"), signerMatch });
    await act(() => button("Check key").click());
    expect(api.summary).toHaveBeenCalledWith(
      { runId: "run", ...(expected ? { expectedFingerprint: expected } : {}) },
      { context: { spaceId: "space" } },
    );
    expect(node.querySelector('[role="status"]')?.textContent).toBe(
      {
        expected_key: "Signed by the expected key",
        different_key: "Signed by a different key",
        no_expected_key: "No expected key given; self-consistent only",
      }[signerMatch],
    );
    await enter("short");
    expect(button("Check key").disabled).toBe(true);
    expect(node.querySelector('[role="status"]')).toBeNull();
  },
);
it("shows a failed comparison without a successful signer label", async () => {
  await openIdentity();
  api.summary.mockResolvedValue({ ...summary("failed"), signerMatch: null });
  await act(() => button("Check key").click());
  expect(node.querySelector('[role="alert"]')?.textContent).toBe("Check failed");
  expect(node.querySelector('[role="status"]')).toBeNull();
});

it("offers manual copying when the clipboard is unavailable", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockRejectedValue(new Error("unavailable")) },
  });
  await openIdentity();
  await act(() => button("Copy fingerprint").click());
  expect(node.querySelector('[role="alert"]')?.textContent).toBe(
    "Could not copy. Select the fingerprint and copy it.",
  );
  expect(node.textContent).toContain(fingerprint);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  await act(() => button("Copy fingerprint").click());
  expect(node.querySelector('[role="alert"]')).toBeNull();
  expect(button("Copied")).toBeTruthy();
});

it("hides an earlier signer match when the run stops verifying", async () => {
  await openIdentity();
  await enter(fingerprint);
  api.summary.mockResolvedValue({ ...summary("verified"), signerMatch: "expected_key" });
  await act(() => button("Check key").click());
  expect(node.querySelector('[role="status"]')?.textContent).toBe("Signed by the expected key");
  await act(() =>
    root.render(
      <EvidenceIdentityDetails
        summary={{
          ...summary("failed"),
          signingIdentity: { fingerprint, scope: { type: "space", id: "space" }, keyVersion: 1 },
          signerMatch: null,
        }}
        spaceId="space"
      />,
    ),
  );
  expect(node.querySelector('[role="status"]')).toBeNull();
});
