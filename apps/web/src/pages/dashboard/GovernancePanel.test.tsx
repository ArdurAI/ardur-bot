// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import GovernancePanel from "./GovernancePanel";

const api = vi.hoisted(() => ({ set: vi.fn(), list: vi.fn() }));
vi.mock("../../lib/rpc", () => ({ rpc: { features: api } }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("@ardurbot/ui-web", () => ({
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: Omit<ComponentProps<"button">, "onChange"> & {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <button
      {...props}
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
    />
  ),
}));
let node: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(() => root.unmount());
  node.remove();
  vi.unstubAllGlobals();
});
async function render(canManage: boolean, state: "enabled" | "disabled" = "disabled") {
  await act(() =>
    root.render(
      <GovernancePanel data={{ feature: "governance", state, canManage, spaceId: "space" }} />,
    ),
  );
}
it("lets only the owner turn recording on, with authoritative readback", async () => {
  await render(true);
  expect(node.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
  api.set.mockResolvedValue({ feature: "governance", state: "enabled" });
  api.list.mockResolvedValue([{ feature: "governance", state: "enabled" }]);
  await act(async () => node.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  expect(api.set).toHaveBeenCalledWith(
    { feature: "governance", state: "enabled" },
    { context: { spaceId: "space" } },
  );
  expect(api.list).toHaveBeenCalled();
  expect(node.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
});
it.each(["enabled", "disabled"] as const)(
  "shows a member the %s state without a control",
  async (state) => {
    await render(false, state);
    expect(node.querySelector('[role="switch"]')).toBeNull();
    expect(node.textContent).toContain(state === "enabled" ? "Evidence on" : "Evidence off");
    expect(api.set).not.toHaveBeenCalled();
  },
);
it("keeps the previous state when saving fails and offers retry", async () => {
  await render(true);
  api.set.mockRejectedValue(new Error("offline"));
  await act(async () => node.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  expect(node.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
  expect(node.querySelector('[role="alert"]')?.textContent).toBe("Could not save. Try again.");
});
