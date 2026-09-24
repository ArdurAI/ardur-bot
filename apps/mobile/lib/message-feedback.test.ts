import type { ReactElement } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { MessageFeedback } from "../components/message-feedback";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (hooks.values.length <= index) hooks.values.push(initial);
    return [
      hooks.values[index],
      (value: unknown) => {
        hooks.values[index] = value;
      },
    ];
  },
}));
vi.mock("react-native", () => ({
  Button: "Button",
  Modal: "Modal",
  TextInput: "TextInput",
  View: "View",
}));
vi.mock("./native", () => ({ native: { page: "page", label: "label", fill: "fill" } }));
vi.mock("./i18n", () => ({ t: (text: string) => text }));
type Node = ReactElement<Record<string, unknown>>;
function nodes(node: unknown): Node[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Node;
  return [element, ...nodes(element.props.children)];
}
beforeEach(() => {
  hooks.values = [];
  hooks.cursor = 0;
});
it("uses native controls to record a thumb, edit a bounded single-line reason, and retract", async () => {
  const onFeedback = vi.fn(async () => undefined);
  const render = () => {
    hooks.cursor = 0;
    return nodes(MessageFeedback({ onFeedback }));
  };
  const button = (title: string) => render().find((node) => node.props.title === title)!;
  (button("👎").props.onPress as () => void)();
  expect(onFeedback).toHaveBeenLastCalledWith("👎");
  const input = render().find((node) => node.props.accessibilityLabel === "What was wrong?")!;
  expect(input.type).toBe("TextInput");
  expect(input.props.maxLength).toBe(500);
  (input.props.onChangeText as (text: string) => void)("Use steps.\nCheck them.");
  (button("Save").props.onPress as () => void)();
  await vi.waitFor(() =>
    expect(onFeedback).toHaveBeenLastCalledWith("👎", {
      reason: "Use steps. Check them.",
      retract: false,
    }),
  );
  (button("👍").props.onPress as () => void)();
  expect(render().some((node) => node.props.accessibilityLabel === "What was good?")).toBe(true);
  (button("Remove feedback").props.onPress as () => void)();
  await vi.waitFor(() =>
    expect(onFeedback).toHaveBeenLastCalledWith("👍", { reason: "", retract: true }),
  );
});
