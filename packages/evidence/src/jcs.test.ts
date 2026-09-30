import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalize } from "./jcs.js";

const vectors = readFileSync(new URL("./__fixtures__/jcs-vectors.jsonl", import.meta.url), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as { input: unknown; jcs: string });

describe("canonicalize", () => {
  it.each(vectors)("matches independent checker vector %#", ({ input, jcs }) => {
    expect(canonicalize(input)).toBe(jcs);
  });
  it.each([
    undefined,
    () => 1,
    Symbol("x"),
    1n,
    NaN,
    Infinity,
    -Infinity,
    Number("9007199254740993"),
    Number("-9007199254740993"),
    "\ud800",
    "\udfff",
    { "\ud800": 1 },
    { "\udfff": 1 },
    new Date(),
    new Map(),
    Buffer.from("x"),
    new (class Example {})(),
    [undefined],
    Array(1),
    { x: undefined },
    { toJSON: () => ({ x: 1 }) },
    { [Symbol("x")]: 1 },
  ])("rejects unsupported value %#", (value) => {
    expect(() => canonicalize(value)).toThrow(TypeError);
  });
  it("accepts exponential unsafe integers and the safe boundary", () => {
    expect(canonicalize([1e21, -1e30, Number.MAX_SAFE_INTEGER])).toBe(
      "[1e+21,-1e+30,9007199254740991]",
    );
  });
  it("does not invoke toJSON or accessors", () => {
    let called = false;
    const value = {
      toJSON() {
        called = true;
        return 1;
      },
    };
    expect(() => canonicalize(value)).toThrow();
    expect(called).toBe(false);
    expect(() =>
      canonicalize({
        get x() {
          throw new Error("accessed");
        },
      }),
    ).toThrow("Accessor");
  });
  it("rejects cycles but accepts repeated objects and null prototypes", () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(() => canonicalize(cyclic)).toThrow("Circular");
    const obj = Object.assign(Object.create(null), { x: "😀" });
    expect(canonicalize([obj, obj])).toBe('[{"x":"😀"},{"x":"😀"}]');
  });
});
