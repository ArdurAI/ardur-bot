// @vitest-environment jsdom
import type { EvidenceRunSummary } from "@ardurbot/contracts/evidence";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EvidenceIdentityDetails, RunEvidence } from "./run-evidence";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), share: vi.fn(), export: vi.fn(), alert: vi.fn() }));
vi.mock("../lib/api", () => ({
  rpc: mocks.rpc,
  selectedSpaceId: () => "space",
  captureApiRequestContext: async () => ({ apiBase: "https://api.example.test", headers: {} }),
}));
vi.mock("../lib/dispatch", () => ({ dispatchClient: { loadHome: async () => ({ id: "home" }) } }));
vi.mock("../lib/appearance", () => ({ mobileTokens: () => ({ mutedForeground: "gray" }) }));
vi.mock("../lib/native", () => ({ native: {} }));
vi.mock("../lib/evidence-export", () => ({
  exportEvidenceIdentity: mocks.export,
  exportRunEvidence: vi.fn(),
}));
vi.mock("./native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("react-native", () => ({
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children, onPress }: { children: ReactNode; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
  ),
  Button: ({
    title,
    onPress,
    disabled,
  }: {
    title: string;
    onPress: () => void;
    disabled: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {title}
    </button>
  ),
  TextInput: ({
    value,
    onChangeText,
  }: {
    value: string;
    onChangeText: (value: string) => void;
  }) => <input value={value} onChange={(event) => onChangeText(event.target.value)} />,
  Modal: ({ children, visible }: { children: ReactNode; visible: boolean }) =>
    visible ? <div>{children}</div> : null,
  Share: { share: mocks.share },
  Alert: { alert: mocks.alert },
  StyleSheet: { create: (value: unknown) => value },
}));
const fingerprint = `sha256:${"a".repeat(64)}`;
const summary: EvidenceRunSummary = {
  sessionId: "run",
  state: "verified",
  sealed: true,
  gapCount: 0,
  failureCodes: [],
  recordedAt: "2026-09-29T12:00:00Z",
  captureLevel: "decisions",
  evidence: null,
  decisions: { allowed: 1, denied: 0, asked: 0, recorded: 1 },
  gates: { spend: null, risks: [] },
  signingIdentity: { fingerprint, scope: { type: "space", id: "space" }, keyVersion: 1 },
  signerMatch: "no_expected_key",
};
let node: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(() => root.unmount());
  node.remove();
  vi.unstubAllGlobals();
});
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
it("reveals fingerprint sharing and card export in paired mode", async () => {
  mocks.rpc.mockResolvedValue(summary);
  await act(async () => root.render(<RunEvidence runId="run" live={false} colorScheme="light" />));
  expect(node.textContent).toBe("Verified");
  await act(() => button("Verified").click());
  expect(node.textContent).toContain(fingerprint);
  expect(button("Download evidence")).toBeUndefined();
  await act(() => button("Share fingerprint").click());
  expect(mocks.share).toHaveBeenCalledWith({ message: fingerprint });
  await act(() => button("Export identity card").click());
  expect(mocks.export).toHaveBeenCalledWith(summary.signingIdentity);
});
it.each(["expected_key", "different_key", "no_expected_key"] as const)(
  "requests and renders %s without treating invalid input as verified",
  async (signerMatch) => {
    await act(() =>
      root.render(
        <EvidenceIdentityDetails summary={summary} spaceId="space" open paired={false} />,
      ),
    );
    const expected = signerMatch === "no_expected_key" ? "" : fingerprint;
    await enter(expected);
    mocks.rpc.mockResolvedValue({ ...summary, signerMatch });
    await act(() => button("Check key").click());
    expect(mocks.rpc).toHaveBeenCalledWith(
      "evidence/runSummary",
      { runId: "run", ...(expected ? { expectedFingerprint: expected } : {}) },
      expect.anything(),
    );
    const label = {
      expected_key: "Signed by the expected key",
      different_key: "Signed by a different key",
      no_expected_key: "No expected key given; self-consistent only",
    }[signerMatch];
    expect(node.textContent).toContain(label);
    await enter("invalid");
    expect(button("Check key").disabled).toBe(true);
    expect(node.textContent).not.toContain(label);
  },
);
it("keeps the revoked key visible after an emergency revocation and replaces against its head", async () => {
  const revokedHistory = {
    canManage: true,
    keys: [
      {
        keyId: fingerprint,
        fingerprint,
        version: 1,
        state: "revoked",
        createdAt: "2026-10-01T00:00:00.000Z",
        replacedAt: null,
        revokedAt: "2026-10-02T00:00:00.000Z",
        revokedReason: "lost device",
      },
    ],
  };
  mocks.rpc.mockImplementation(async (procedure: string) =>
    procedure === "evidence/runSummary" ? summary : revokedHistory,
  );
  await act(async () =>
    root.render(<EvidenceIdentityDetails summary={summary} spaceId="space" open paired={false} />),
  );
  await act(async () => {
    await Promise.resolve();
  });
  // The identity keeps the revoked key's fingerprint and its status so the
  // owner can authorize the replacing key.
  expect(node.textContent).toContain(fingerprint);
  expect(node.textContent).toContain("Revoked");
  await act(() => button("Replace key").click());
  const [, , buttons] = mocks.alert.mock.calls[0] as [
    string,
    string,
    { text: string; onPress?: () => void }[],
  ];
  await act(() => buttons.find((item) => item.text === "Replace key")!.onPress!());
  expect(mocks.rpc).toHaveBeenCalledWith(
    "evidence/replaceKey",
    { expectedFingerprint: fingerprint },
    expect.anything(),
  );
});

it("reports failed verification without a signer success", async () => {
  await act(() =>
    root.render(<EvidenceIdentityDetails summary={summary} spaceId="space" open paired={false} />),
  );
  mocks.rpc.mockResolvedValue({ ...summary, state: "failed", signerMatch: null });
  await act(() => button("Check key").click());
  expect(mocks.alert).toHaveBeenCalledWith("Check failed");
  expect(node.textContent).not.toContain("self-consistent only");
});

it("hides an earlier signer match when the run stops verifying", async () => {
  await act(() =>
    root.render(<EvidenceIdentityDetails summary={summary} spaceId="space" open paired={false} />),
  );
  await enter(fingerprint);
  mocks.rpc.mockResolvedValue({ ...summary, signerMatch: "expected_key" });
  await act(() => button("Check key").click());
  expect(node.textContent).toContain("Signed by the expected key");
  await act(() =>
    root.render(
      <EvidenceIdentityDetails
        summary={{ ...summary, state: "failed", sealed: false, signerMatch: null }}
        spaceId="space"
        open
        paired={false}
      />,
    ),
  );
  expect(node.textContent).not.toContain("Signed by the expected key");
});
