// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  beginOAuth: vi.fn(),
  cancelOAuth: vi.fn(),
  finishOAuth: vi.fn(),
  open: vi.fn(),
  waitForModelOAuth: vi.fn(),
}));
vi.mock("./rpc", () => ({ rpc: { models: api } }));
vi.mock("./desktop", () => ({
  desktopBridge: () => ({ oauth: { open: api.open } }),
  oauthStateOf: () => null,
  onDesktopOAuthCallback: () => () => undefined,
}));
vi.mock("./model-auth", () => ({ waitForModelOAuth: api.waitForModelOAuth }));

import { useModelOAuthSignIn } from "./use-model-oauth-signin";

let node: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const persistenceChange = vi.fn();
function Pairing() {
  const { startSubscriptionSignIn } = useModelOAuthSignIn({
    onFinished: () => undefined,
    onError: () => undefined,
    onPersistenceChange: persistenceChange,
  });
  return (
    <button
      type="button"
      onClick={() => void startSubscriptionSignIn({ provider: "fixture", modelId: "model" })}
    >
      Pair
    </button>
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  api.beginOAuth.mockResolvedValue({
    mode: "device-code",
    loginId: "login-a",
    verificationUri: "https://example.com/verify",
    userCode: "ABCD",
  });
  api.open.mockResolvedValue(undefined);
  api.cancelOAuth.mockResolvedValue(undefined);
  api.waitForModelOAuth.mockImplementation(() => new Promise<void>(() => undefined));
  node = document.createElement("div");
  root = createRoot(node);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it("cancels an owned pairing attempt when the Models view closes", async () => {
  await act(async () => root.render(<Pairing />));
  await act(async () => node.querySelector("button")?.click());
  await vi.waitFor(() => expect(api.waitForModelOAuth).toHaveBeenCalledOnce());
  await act(async () => root.unmount());
  expect(api.cancelOAuth).toHaveBeenCalledWith({ loginId: "login-a" });
  expect(api.finishOAuth).not.toHaveBeenCalled();
});

it("reports OAuth persistence until finish completes", async () => {
  let finish!: () => void;
  api.waitForModelOAuth.mockResolvedValue(undefined);
  api.finishOAuth.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  await act(async () => root.render(<Pairing />));
  await act(async () => node.querySelector("button")?.click());
  expect(api.finishOAuth).toHaveBeenCalledOnce();
  expect(persistenceChange).toHaveBeenCalledWith(true);
  expect(persistenceChange).not.toHaveBeenCalledWith(false);
  await act(async () => finish());
  expect(persistenceChange).toHaveBeenLastCalledWith(false);
});
