import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, i) => text + part + (values[i] ?? ""), ""),
    i18n: {
      locale: "en",
      _: (value: { message?: string; id: string } | string) =>
        typeof value === "string" ? value : (value.message ?? value.id),
    },
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@lingui/core/macro", () => ({
  msg: (parts: TemplateStringsArray) => ({ id: parts.join(""), message: parts.join("") }),
}));
vi.mock("@ardurbot/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const Button = ({
    variant: _variant,
    size: _size,
    render: _render,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string; render?: ReactNode }) => (
    <button {...props} />
  );
  return {
    Button,
    Skeleton: (props: ComponentProps<"div">) => <div {...props} />,
    AlertDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? <div role="alertdialog">{children}</div> : null,
    AlertDialogAction: Button,
    AlertDialogCancel: Button,
    AlertDialogContent: Container,
    AlertDialogDescription: Container,
    AlertDialogFooter: Container,
    AlertDialogHeader: Container,
    AlertDialogTitle: Container,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
    Toggle: ({
      pressed,
      onPressedChange,
      variant: _variant,
      ...props
    }: ComponentProps<"button"> & {
      pressed: boolean;
      onPressedChange: (pressed: boolean) => void;
      variant?: string;
    }) => <button {...props} aria-pressed={pressed} onClick={() => onPressedChange(!pressed)} />,
    Switch: ({
      checked,
      onCheckedChange,
      ...props
    }: ComponentProps<"button"> & {
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
    Dialog: Container,
    DialogContent: ({
      initialFocus: _focus,
      showCloseButton: _close,
      ...props
    }: ComponentProps<"div"> & { initialFocus?: unknown; showCloseButton?: boolean }) => (
      <div {...props} />
    ),
    DialogTitle: (props: ComponentProps<"h2">) => <h2 {...props} />,
    DialogClose: Button,
    BotAvatar: () => null,
    Field: Container,
    FieldLabel: (props: ComponentProps<"label">) => (
      <label htmlFor={props.htmlFor} {...props}>
        {props.children}
      </label>
    ),
  };
});
vi.mock("../components/ai/primitives", () => ({
  LoadingState: ({ label }: { label: string }) => <div>{label}</div>,
  SuccessPop: () => null,
}));
vi.mock("../components/ShellSkeleton", () => ({ ShellSkeleton: () => <div>Loading</div> }));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
  delete window.ardurbotDesktop;
});
export async function renderSettings(element: ReactNode) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () => root.render(element));
  return { container, root };
}
export async function changeInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
export async function waitForSettings(check: () => boolean) {
  for (let i = 0; i < 500 && !check(); i++)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  if (!check()) throw new Error("Settings did not render");
}
