// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  start: vi.fn(),
  revoke: vi.fn(),
  rename: vi.fn(),
  confirm: vi.fn(),
  installations: vi.fn(),
  channelStart: vi.fn(),
  bots: vi.fn(),
}));
vi.mock("../lib/rpc", () => ({
  rpc: {
    devices: api,
    pairing: api,
    channelPairing: { installations: api.installations, start: api.channelStart },
    bots: { list: api.bots },
  },
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, i) => text + part + (values[i] ?? ""), "");
  return { useLingui: () => ({ t }) };
});
vi.mock("@ardurbot/ui-web", () => ({
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button {...props} />
  ),
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked: boolean;
    onCheckedChange: (v: boolean) => void;
  }) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange(event.target.checked)}
      {...props}
    />
  ),
}));

import { DevicesSettings } from "./DevicesSettings";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  api.installations.mockResolvedValue([
    { id: "installation", provider: "telegram", workspaceId: "telegram", botId: "bot" },
  ]);
  api.bots.mockResolvedValue([{ id: "bot", name: "Research bot" }]);
  api.channelStart.mockResolvedValue({
    code: "PAIRTEST1234",
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  });
  api.list.mockResolvedValue({
    fingerprint: "a".repeat(64),
    pending: [{ id: "pending", deviceName: "Pending phone", publicKeyFingerprint: "b".repeat(64) }],
    devices: [
      {
        id: "phone",
        deviceName: "Phone",
        scopes: ["read"],
        lastUsedAt: null,
        lastPresenceAt: null,
        revokedAt: null,
      },
    ],
  });
  api.start.mockResolvedValue({
    payload: {
      version: 1,
      challenge: "nonredeemable-test-challenge",
      instanceId: "test-home",
      homeName: "Test home",
      fingerprint: "a".repeat(64),
      certificateFingerprint: "b".repeat(64),
      hints: [],
    },
    shortCode: "TESTCODE",
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === label,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
it("shows the fingerprint, pairing and per-device revoke and confirmation controls", async () => {
  await act(async () => root.render(<DevicesSettings owner />));
  expect(container.textContent).toContain("Last present: Never");
  expect(container.textContent).toContain("a".repeat(64));
  await click("Pair device");
  expect(container.querySelector("svg[role=img]")).not.toBeNull();
  expect(container.textContent).toContain("TESTCODE");
  await click("Revoke");
  expect(api.revoke).toHaveBeenCalledWith({ id: "phone" });
  await click("Allow device");
  expect(api.confirm).toHaveBeenCalledWith({ id: "pending", allow: true });
  await click("Rename");
  expect(container.querySelector("input[aria-label='Device name']")).not.toBeNull();
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(api.rename).toHaveBeenCalledWith({ id: "phone", deviceName: "Phone" });
});
it("keeps device management with the owner", async () => {
  await act(async () => root.render(<DevicesSettings owner={false} />));
  expect(api.list).not.toHaveBeenCalled();
  expect(container.textContent).toContain("home owner account");
});

it("reveals chat pairing only when requested and shares the device list", async () => {
  await act(async () => root.render(<DevicesSettings owner />));
  expect(api.installations).not.toHaveBeenCalled();
  await click("Pair a chat account");
  expect(api.installations).toHaveBeenCalledOnce();
  const form = container.querySelector("form")!;
  await act(async () =>
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(api.channelStart).toHaveBeenCalledWith({ installationId: "installation", botId: "bot" });
  expect(container.textContent).toContain("PAIRTEST1234");
  expect(container.textContent).toContain("private message");
});
