import { COMMAND_OUTPUT_LIMIT, COMMAND_TRUNCATED } from "@ardurbot/core";
import { describe, expect, it } from "vitest";
import { createDockerCommandOutput } from "./command-output.js";

function frame(stream: number, text: string) {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}
describe("bounded supervisor command output", () => {
  it("demultiplexes split headers and Unicode without mixing stdout and stderr", () => {
    const output = createDockerCommandOutput();
    const bytes = Buffer.concat([frame(1, "😀 out"), frame(2, "err")]);
    for (const byte of bytes) output.push(Buffer.from([byte]));
    expect(output.finish()).toEqual({ stdout: "😀 out", stderr: "err" });
  });
  it("drains flood frames with bounded retained output and explicit markers", () => {
    const output = createDockerCommandOutput();
    for (let i = 0; i < 100; i++) output.push(frame(1, "x".repeat(4096)));
    output.push(frame(2, "still separate"));
    const result = output.finish();
    expect(result.stdout.length).toBeLessThan(COMMAND_OUTPUT_LIMIT + 40);
    expect(result.stdout).toContain(COMMAND_TRUNCATED);
    expect(result.stderr).toBe("still separate");
  });
  it("rejects interrupted frames instead of manufacturing success", () => {
    const output = createDockerCommandOutput();
    output.push(frame(1, "partial").subarray(0, 10));
    expect(() => output.finish()).toThrow("Incomplete");
  });
  it("preserves larger internal file and image payloads outside shell recording", () => {
    const output = createDockerCommandOutput(Number.POSITIVE_INFINITY);
    const content = "x".repeat(COMMAND_OUTPUT_LIMIT * 2);
    output.push(frame(1, content));
    expect(output.finish().stdout).toBe(content);
  });
});
