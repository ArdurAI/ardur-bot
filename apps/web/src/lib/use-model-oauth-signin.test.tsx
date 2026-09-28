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
  refresh: vi.fn(),
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
  const { cancelOAuthAttempt, startSubscriptionSignIn } = useModelOAuthSignIn({
    onFinished: api.refresh,
    onError: () => undefined,
    onPersistenceChange: persistenceChange,
  });
  return (
    <>
      <button
        type="button"
        onClick={() => void startSubscriptionSignIn({ provider: "fixture", modelId: "model" })}
      >
        Pair
      </button>
      <button type="button" onClick={() => cancelOAuthAttempt()}>
        Cancel
      </button>
    </>
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
  api.refresh.mockResolvedValue(undefined);
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
  api.finishOAuth.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => root.render(<Pairing />));
  await act(async () => node.querySelector("button")?.click());
  expect(api.finishOAuth).toHaveBeenCalledOnce();
  expect(persistenceChange).toHaveBeenCalledWith(true);
  expect(persistenceChange).not.toHaveBeenCalledWith(false);
  await act(async () => finish());
  expect(persistenceChange).toHaveBeenLastCalledWith(false);
});

it("keeps persistence pending when an older refresh settles during a retry", async () => {
  let finishOlderRefresh!: () => void;
  let finishNewerSave!: () => void;
  api.beginOAuth
    .mockResolvedValueOnce({
      mode: "device-code",
      loginId: "login-a",
      verificationUri: "https://example.com/verify",
      userCode: "ABCD",
    })
    .mockResolvedValueOnce({
      mode: "device-code",
      loginId: "login-b",
      verificationUri: "https://example.com/verify",
      userCode: "EFGH",
    });
  api.waitForModelOAuth.mockResolvedValue(undefined);
  api.finishOAuth.mockResolvedValueOnce(undefined).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishNewerSave = resolve;
      }),
  );
  api.refresh.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishOlderRefresh = resolve;
      }),
  );
  await act(async () => root.render(<Pairing />));
  const [pair, cancel] = node.querySelectorAll("button");
  await act(async () => pair?.click());
  expect(api.refresh).toHaveBeenCalledOnce();
  await act(async () => cancel?.click());
  await act(async () => pair?.click());
  expect(api.finishOAuth).toHaveBeenCalledTimes(2);
  expect(persistenceChange).toHaveBeenLastCalledWith(true);

  await act(async () => finishOlderRefresh());
  expect(persistenceChange).not.toHaveBeenCalledWith(false);

  await act(async () => finishNewerSave());
  expect(persistenceChange).toHaveBeenLastCalledWith(false);
});
