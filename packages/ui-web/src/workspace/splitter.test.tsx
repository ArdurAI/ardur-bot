// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { Splitter } from "./splitter.js";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
});

function rect(width: number, height: number) {
  return {
    width,
    height,
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    toJSON() {
      return {};
    },
  } as DOMRect;
}

async function render(
  value: number,
  onChange: (next: number) => void,
  props: Partial<{
    label: string;
    horizontal: boolean;
    min: number;
    max: number;
    step: number;
    invert: boolean;
    unit: "percent" | "px";
  }> = {},
) {
  host = document.createElement("div");
  document.body.append(host);
  host.getBoundingClientRect = () => rect(200, 100);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <Splitter label={props.label ?? "Resize"} value={value} onChange={onChange} {...props} />,
    ),
  );
  return host.querySelector("hr")!;
}

function press(separator: HTMLElement, key: string) {
  separator.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

function drag(separator: HTMLElement, from: number, to: number, axis: "x" | "y") {
  const point = (at: number) =>
    axis === "x" ? { clientX: at, clientY: 0 } : { clientX: 0, clientY: at };
  separator.dispatchEvent(new PointerEvent("pointerdown", { ...point(from), bubbles: true }));
  separator.dispatchEvent(new PointerEvent("pointermove", { ...point(to), bubbles: true }));
  separator.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
}

it("keeps percent defaults so an IDE drag still grows toward the pointer", async () => {
  const changes: number[] = [];
  const separator = await render(22, (next) => changes.push(next));
  expect(separator.tabIndex).toBe(0);
  expect(separator.getAttribute("aria-orientation")).toBe("vertical");
  expect(separator.getAttribute("aria-valuemin")).toBe("15");
  expect(separator.getAttribute("aria-valuemax")).toBe("40");
  expect(separator.getAttribute("aria-valuenow")).toBe("22");
  await act(async () => {
    press(separator, "ArrowRight");
    press(separator, "ArrowLeft");
    press(separator, "Home");
    press(separator, "End");
    drag(separator, 0, 40, "x");
  });
  expect(changes).toEqual([24, 20, 15, 40, 42]);
});

it("grows a horizontal splitter upward and ends at the horizontal limit", async () => {
  const changes: number[] = [];
  const separator = await render(30, (next) => changes.push(next), { horizontal: true });
  expect(separator.getAttribute("aria-orientation")).toBe("horizontal");
  expect(separator.getAttribute("aria-valuemax")).toBe("65");
  await act(async () => {
    press(separator, "ArrowUp");
    press(separator, "ArrowDown");
    press(separator, "End");
    drag(separator, 40, 20, "y");
  });
  expect(changes).toEqual([32, 28, 65, 50]);
});

it("resizes pixel widths in the inverted direction and still moves when the parent has no size", async () => {
  const changes: number[] = [];
  const separator = await render(400, (next) => changes.push(next), {
    unit: "px",
    invert: true,
    min: 360,
    max: 800,
    step: 20,
  });
  host.getBoundingClientRect = () => rect(0, 0);
  expect(separator.getAttribute("aria-valuemin")).toBe("360");
  expect(separator.getAttribute("aria-valuemax")).toBe("800");
  await act(async () => {
    press(separator, "ArrowLeft");
    press(separator, "ArrowRight");
    press(separator, "Home");
    press(separator, "End");
    drag(separator, 100, 70, "x");
  });
  expect(changes).toEqual([420, 380, 360, 800, 430]);
});
