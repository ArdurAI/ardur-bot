// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, i) => text + part + (values[i] ?? ""), ""),
  }),
}));
vi.mock("@ardurbot/ui-web", () => {
  const Container = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: Container,
    DialogContent: Container,
    DialogFooter: Container,
    DialogHeader: Container,
    DialogTitle: Container,
    Field: Container,
    FieldLabel: (props: ComponentProps<"label">) => (
      <label htmlFor={props.htmlFor}>{props.children}</label>
    ),
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
    Button: ({ variant: _, ...props }: ComponentProps<"button"> & { variant?: string }) => (
      <button {...props} />
    ),
    Checkbox: ({
      checked,
      onCheckedChange,
      ...props
    }: Omit<ComponentProps<"input">, "onChange"> & { onCheckedChange(value: boolean): void }) => (
      <input
        {...props}
        type="checkbox"
        checked={checked}
        onChange={(event) => onCheckedChange(event.target.checked)}
      />
    ),
  };
});

import { ConfigureExtension } from "./ConfigureExtension";

it.each([false, true])(
  "renders typed fields, keeps saved secrets blank and picks folders (sensitive: %s)",
  async (sensitive) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    const save = vi.fn(async () => {});
    const close = vi.fn();
    const pick = vi.fn(async () => ["/fixture/a", "/fixture/b"]);
    try {
      await act(async () =>
        root.render(
          <ConfigureExtension
            name="Fixture"
            fields={[
              {
                key: "token",
                type: "string",
                title: "Token",
                description: "",
                sensitive: true,
                required: true,
                configured: true,
              },
              {
                key: "limit",
                type: "number",
                title: "Limit",
                description: "",
                configured: true,
                value: 2,
                min: 1,
                max: 5,
              },
              {
                key: "enabled",
                type: "boolean",
                title: "Enabled",
                description: "",
                configured: true,
                value: true,
              },
              {
                key: "folders",
                type: "directory",
                title: "Folders",
                description: "",
                multiple: true,
                sensitive,
                configured: false,
              },
            ]}
            onSave={save}
            onClose={close}
            pickPath={pick}
          />,
        ),
      );
      const secret = container.querySelector<HTMLInputElement>('[type="password"]')!;
      expect(secret.value).toBe("");
      expect(secret.placeholder).toBe("Saved");
      expect(secret.required).toBe(false);
      expect(container.querySelector<HTMLInputElement>('[type="number"]')?.max).toBe("5");
      expect(container.querySelector<HTMLInputElement>('[type="checkbox"]')?.checked).toBe(true);
      const choose = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Choose",
      )!;
      await act(async () => choose.click());
      if (sensitive) {
        expect(
          [...container.querySelectorAll<HTMLInputElement>('[aria-label="Folders"]')].map(
            (input) => input.value,
          ),
        ).toEqual(["/fixture/a", "/fixture/b"]);
        expect(container.querySelector<HTMLInputElement>('[aria-label="Folders"]')?.type).toBe(
          "password",
        );
      } else expect(container.querySelector("textarea")?.value).toBe("/fixture/a\n/fixture/b");
      await act(async () =>
        container
          .querySelector("form")!
          .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      expect(save).toHaveBeenCalledWith({
        limit: 2,
        enabled: true,
        folders: ["/fixture/a", "/fixture/b"],
      });
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  },
);
