// @vitest-environment jsdom
import { COMPUTER_IMAGE_DOWNLOAD_FAILED_CODE, errorDataCode } from "@ardurbot/contracts";
import { act, useReducer, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray) => parts.join(""),
}));

import { loadComputerScreen } from "../../lib/computer-screen";
import {
  initialComputerErrorState,
  reduceComputerError,
  visibleComputerError,
} from "./computer-error-state";
import { ComputerScreenError } from "./computer-screen-error";

const containers: HTMLDivElement[] = [];
afterEach(() => {
  for (const container of containers) container.remove();
  containers.length = 0;
});

it.each([
  [COMPUTER_IMAGE_DOWNLOAD_FAILED_CODE, "Try again", "provision"],
  [undefined, "Retry screen", "screen"],
] as const)("routes %s retry to %s", async (code, label, target) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  const provision = vi.fn();
  const screen = vi.fn();
  await act(async () => {
    root.render(
      <ComputerScreenError
        message="Computer image unavailable"
        code={code}
        onRetryProvision={provision}
        onRetryScreen={screen}
      />,
    );
  });
  const button = container.querySelector("button");
  expect(button?.textContent).toBe(label);
  await act(async () => button?.click());
  expect(provision).toHaveBeenCalledTimes(target === "provision" ? 1 : 0);
  expect(screen).toHaveBeenCalledTimes(target === "screen" ? 1 : 0);
  await act(async () => root.unmount());
});

it("keeps a boot download error after a pending screen request returns no URL", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  const retryProvision = vi.fn();
  const retryScreen = vi.fn();
  let rejectBoot!: (error: Error) => void;
  let finishScreen!: (screen: { url: string | null }) => void;
  const bootRequest = new Promise<void>((_, reject) => {
    rejectBoot = reject;
  });
  const screenRequest = new Promise<{ url: string | null }>((resolve) => {
    finishScreen = resolve;
  });

  function Harness() {
    const [state, dispatch] = useReducer(reduceComputerError, initialComputerErrorState);
    const currentRequest = useRef(0);
    const displayedError = visibleComputerError(state, false);
    return (
      <>
        <button
          type="button"
          onClick={() => {
            const requestId = ++currentRequest.current;
            dispatch({ type: "screen-requested", requestId, computerId: "computer" });
            void loadComputerScreen({
              load: () => screenRequest,
              isCurrent: () => requestId === currentRequest.current,
              observe: (result) =>
                dispatch({ type: "screen-result", requestId, computerId: "computer", result }),
              commit: () => undefined,
              fallbackError: "Could not connect",
            });
          }}
        >
          Refresh screen
        </button>
        <button
          type="button"
          onClick={() => {
            dispatch({ type: "boot-started" });
            void bootRequest.catch((error: Error) => {
              dispatch({
                type: "operation-failed",
                message: error.message,
                code: errorDataCode(error),
              });
            });
          }}
        >
          Boot computer
        </button>
        {displayedError ? (
          <ComputerScreenError
            message={displayedError.message}
            code={displayedError.code}
            onRetryProvision={retryProvision}
            onRetryScreen={retryScreen}
          />
        ) : null}
      </>
    );
  }

  await act(async () => root.render(<Harness />));
  await act(async () => {
    container.querySelectorAll("button")[0]?.click();
    container.querySelectorAll("button")[1]?.click();
  });
  await act(async () => {
    rejectBoot(
      Object.assign(new Error("Computer image could not be downloaded"), {
        data: { code: COMPUTER_IMAGE_DOWNLOAD_FAILED_CODE },
      }),
    );
  });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Computer image could not be downloaded",
  );
  expect(container.querySelector('[role="alert"] button')?.textContent).toBe("Try again");

  await act(async () => finishScreen({ url: null }));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Computer image could not be downloaded",
  );
  const retry = container.querySelector<HTMLButtonElement>('[role="alert"] button');
  expect(retry?.textContent).toBe("Try again");
  await act(async () => retry?.click());
  expect(retryProvision).toHaveBeenCalledOnce();
  expect(retryScreen).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

it("shows the screen after an explicit retry recovers from a post-boot refresh failure", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  const boot = vi.fn().mockResolvedValue(undefined);
  const refreshAfterBoot = vi.fn().mockRejectedValue(new Error("Temporary refresh failure"));
  const loadScreen = vi.fn().mockResolvedValue({ url: "/screen" });

  function Harness() {
    const [state, dispatch] = useReducer(reduceComputerError, initialComputerErrorState);
    const [screenUrl, setScreenUrl] = useState<string | null>(null);
    const currentRequest = useRef(0);
    const displayedError = visibleComputerError(state, Boolean(screenUrl));
    return (
      <>
        <button
          type="button"
          onClick={() => {
            dispatch({ type: "boot-started" });
            void boot()
              .then(refreshAfterBoot)
              .catch((error: Error) => {
                dispatch({ type: "operation-failed", message: error.message });
              });
          }}
        >
          Boot computer
        </button>
        {displayedError ? (
          <ComputerScreenError
            message={displayedError.message}
            code={displayedError.code}
            onRetryProvision={() => undefined}
            onRetryScreen={() => {
              const requestId = ++currentRequest.current;
              dispatch({
                type: "screen-requested",
                requestId,
                computerId: "computer",
                retryErrorId: state.operation?.errorId,
              });
              void loadComputerScreen({
                load: loadScreen,
                isCurrent: () => requestId === currentRequest.current,
                observe: (result) =>
                  dispatch({ type: "screen-result", requestId, computerId: "computer", result }),
                commit: (result) => setScreenUrl(result.url),
                fallbackError: "Could not connect",
              });
            }}
          />
        ) : screenUrl ? (
          <iframe title="Computer screen" src={screenUrl} />
        ) : null}
      </>
    );
  }

  await act(async () => root.render(<Harness />));
  await act(async () => container.querySelector<HTMLButtonElement>("button")?.click());
  expect(boot).toHaveBeenCalledOnce();
  expect(refreshAfterBoot).toHaveBeenCalledOnce();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Temporary refresh failure",
  );
  expect(container.querySelector("iframe")).toBeNull();

  await act(async () =>
    container.querySelector<HTMLButtonElement>('[role="alert"] button')?.click(),
  );
  expect(loadScreen).toHaveBeenCalledOnce();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector("iframe")?.getAttribute("src")).toBe("/screen");
  await act(async () => root.unmount());
});

it("keeps an explicit retry when a background screen request supersedes it", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  let finishRetry!: (screen: { url: string | null }) => void;
  let finishBackground!: (screen: { url: string | null }) => void;
  const retryRequest = new Promise<{ url: string | null }>((resolve) => {
    finishRetry = resolve;
  });
  const backgroundRequest = new Promise<{ url: string | null }>((resolve) => {
    finishBackground = resolve;
  });
  const failed = reduceComputerError(initialComputerErrorState, {
    type: "operation-failed",
    message: "Refresh failed",
  });

  function Harness() {
    const [state, dispatch] = useReducer(reduceComputerError, failed);
    const [screenUrl, setScreenUrl] = useState<string | null>(null);
    const currentRequest = useRef(0);
    const displayedError = visibleComputerError(state, Boolean(screenUrl));
    function startScreenRequest(load: () => Promise<{ url: string | null }>, retry = false) {
      const requestId = ++currentRequest.current;
      dispatch({
        type: "screen-requested",
        requestId,
        computerId: "computer",
        retryErrorId: retry ? state.operation?.errorId : undefined,
      });
      void loadComputerScreen({
        load,
        isCurrent: () => requestId === currentRequest.current,
        observe: (result) =>
          dispatch({ type: "screen-result", requestId, computerId: "computer", result }),
        commit: (result) => setScreenUrl(result.url),
        fallbackError: "Could not connect",
      });
    }
    return (
      <>
        <button type="button" onClick={() => startScreenRequest(() => backgroundRequest)}>
          Background refresh
        </button>
        {displayedError ? (
          <ComputerScreenError
            message={displayedError.message}
            code={displayedError.code}
            onRetryProvision={() => undefined}
            onRetryScreen={() => startScreenRequest(() => retryRequest, true)}
          />
        ) : screenUrl ? (
          <iframe title="Computer screen" src={screenUrl} />
        ) : null}
      </>
    );
  }

  await act(async () => root.render(<Harness />));
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[role="alert"] button')?.click(),
  );
  await act(async () => container.querySelector<HTMLButtonElement>("button")?.click());
  await act(async () => finishRetry({ url: "/older-screen" }));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector("iframe")).toBeNull();
  await act(async () => finishBackground({ url: "/screen" }));
  expect(container.querySelector("iframe")?.getAttribute("src")).toBe("/screen");
  await act(async () => root.unmount());
});
