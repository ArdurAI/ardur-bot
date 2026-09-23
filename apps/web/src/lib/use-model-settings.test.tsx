// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ me: vi.fn(), list: vi.fn(), credentials: vi.fn() }));
vi.mock("./rpc", () => ({ rpc: { me: api.me, models: api } }));

import { useModelSettings } from "./use-model-settings";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
function View({ spaceId }: { spaceId: string }) {
  const settings = useModelSettings(spaceId);
  return <span>{settings?.me.defaultModel ?? "loading"}</span>;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  api.list.mockResolvedValue([]);
  api.credentials.mockResolvedValue([]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("ignores a late response from the previous space", async () => {
  let finishFirst: (value: unknown) => void = () => undefined;
  api.me.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishFirst = resolve;
      }),
  );
  await act(async () => root.render(<View spaceId="first" />));
  api.me.mockResolvedValue({ defaultProvider: "openai-codex", defaultModel: "gpt-6-astra" });
  await act(async () => root.render(<View spaceId="second" />));
  expect(container.textContent).toBe("gpt-6-astra");
  await act(async () => finishFirst({ defaultModel: "stale-model" }));
  expect(container.textContent).toBe("gpt-6-astra");
});

it("does not display the previous account's catalog when the new load fails", async () => {
  api.me.mockResolvedValue({ defaultProvider: "openai-codex", defaultModel: "gpt-6-astra" });
  await act(async () => root.render(<View spaceId="first" />));
  api.me.mockRejectedValue(new Error("offline"));
  await act(async () => root.render(<View spaceId="second" />));
  expect(container.textContent).toBe("loading");
});
