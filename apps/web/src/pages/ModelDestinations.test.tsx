// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ModelDestinations } from "./ModelDestinations";

const api = vi.hoisted(() => ({ policy: vi.fn(), setPolicy: vi.fn() }));
vi.mock("../lib/rpc", () => ({ rpc: { delegations: api } }));
vi.mock("../lib/use-can-run", () => ({ runSettingsMessage: (message: string) => message }));
const translate = vi.hoisted(() => (parts: TemplateStringsArray) => parts.join(""));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => children,
  useLingui: () => ({ t: translate }),
}));
vi.mock("@ardurbot/ui-web", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  NativeSelect: (props: React.SelectHTMLAttributes<HTMLSelectElement>) => <select {...props} />,
  NativeSelectOption: (props: React.OptionHTMLAttributes<HTMLOptionElement>) => (
    <option {...props} />
  ),
}));
let node: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  api.policy.mockReset().mockResolvedValue({ mode: "any" });
  api.setPolicy.mockReset();
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
});
async function chooseLocal() {
  await act(async () => {
    const select = node.querySelector("select")!;
    select.value = "local";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

it("a refused space policy shows the server reason and affected bots, and retains the saved policy", async () => {
  api.setPolicy.mockRejectedValue({
    code: "BAD_REQUEST",
    message: "This space's model policy blocks this model. Change it in Settings, under Models.",
    data: {
      blockedBots: [
        { id: "a", name: "Alpha" },
        { id: "b", name: "Beta" },
      ],
    },
  });
  await act(async () => root.render(<ModelDestinations />));
  await chooseLocal();
  expect(node.querySelector('[role="alert"]')!.textContent).toContain(
    "This space's model policy blocks this model.",
  );
  expect(node.textContent).toContain("Change these bots' models first: Alpha, Beta");
  expect(node.querySelector("select")!.value).toBe("any");
  api.setPolicy.mockResolvedValue({ ok: true });
  await chooseLocal();
  expect(node.querySelector("select")!.value).toBe("local");
  expect(node.querySelector('[role="alert"]')).toBeNull();
});

it("does not display private transport errors or untrusted diagnostic names", async () => {
  api.setPolicy.mockRejectedValue({
    code: "INTERNAL_SERVER_ERROR",
    message: "private details",
    data: { blockedBots: [{ name: "private name" }] },
  });
  await act(async () => root.render(<ModelDestinations botId="bot" />));
  await chooseLocal();
  expect(node.textContent).toContain("Could not save destinations; try again.");
  expect(node.textContent).not.toContain("private");
});
