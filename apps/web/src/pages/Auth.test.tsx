// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ signUp: vi.fn(), signIn: vi.fn(), refetch: vi.fn() }));
vi.mock("../lib/auth", () => ({
  authClient: {
    useSession: () => ({ data: null, isPending: false, refetch: auth.refetch }),
    signUp: { email: auth.signUp },
    signIn: { email: auth.signIn },
  },
}));
vi.mock("../lib/rpc", () => ({ clearSpaceSelection: vi.fn() }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@ardurbot/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Label: (props: ComponentProps<"label">) => (
    <label htmlFor={props.htmlFor} {...props}>
      {props.children}
    </label>
  ),
}));

import { AuthPage } from "./Auth";

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("waits for the public session refetch before entering onboarding", async () => {
  let finishRefresh!: () => void;
  auth.signUp.mockResolvedValue({ data: { token: "fixture-token" }, error: null });
  auth.refetch.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishRefresh = resolve;
      }),
  );
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/sign-up"]}>
        <Routes>
          <Route path="/sign-up" element={<AuthPage mode="up" />} />
          <Route path="/onboarding" element={<output data-testid="onboarding">ready</output>} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
  expect(auth.signUp).toHaveBeenCalledOnce();
  expect(auth.refetch).toHaveBeenCalledOnce();
  expect(container.querySelector('[data-testid="onboarding"]')).toBeNull();

  await act(async () => finishRefresh());
  expect(container.querySelector('[data-testid="onboarding"]')?.textContent).toBe("ready");
});

it("keeps the guided destination through sign-up and returns there after registration", async () => {
  auth.signUp.mockResolvedValue({ data: { token: "fixture-token" }, error: null });
  auth.refetch.mockResolvedValue(undefined);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/sign-in?next=%2Fguided-onboarding%3Fstep%3Dmodel"]}>
        <Routes>
          <Route path="/sign-in" element={<AuthPage mode="in" />} />
          <Route path="/sign-up" element={<AuthPage mode="up" />} />
          <Route path="/guided-onboarding" element={<output data-testid="guided">ready</output>} />
          <Route path="/onboarding" element={<output data-testid="legacy">legacy</output>} />
        </Routes>
      </MemoryRouter>,
    );
  });
  expect(container.querySelector<HTMLAnchorElement>('a[href^="/sign-up"]')?.getAttribute("href"))
    .toBe("/sign-up?next=%2Fguided-onboarding%3Fstep%3Dmodel");
  await act(async () => container.querySelector<HTMLAnchorElement>('a[href^="/sign-up"]')?.click());
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(container.querySelector('[data-testid="guided"]')?.textContent).toBe("ready");
  expect(container.querySelector('[data-testid="legacy"]')).toBeNull();
});
