import { describe, expect, it } from "vitest";
import { decodeHostFrame, encodeHostFrame, HOST_FRAME_BYTES } from "./host-bridge.js";
import { IDE_FILE_BYTES, IdePathSchema, ideHandoffText } from "./ide.js";

describe("IDE contracts", () => {
  it("encodes a full owner save while keeping ordinary host frames bounded", () => {
    const request = {
      v: 1,
      type: "request",
      id: "request",
      scope: { userId: "owner", spaceId: "space", botId: "ide", runId: "operation" },
      operation: {
        op: "computer.files.write",
        homeKey: "ide",
        path: "/project/main.ts",
        content: Buffer.alloc(IDE_FILE_BYTES, 97).toString("base64"),
        editor: true,
      },
    } as const;
    expect(decodeHostFrame(encodeHostFrame(request))).toEqual(request);
    expect(() =>
      encodeHostFrame({ ...request, operation: { ...request.operation, editor: undefined } }),
    ).toThrow("too large");
    expect(() =>
      encodeHostFrame({
        v: 1,
        type: "stream",
        id: "r",
        seq: 0,
        channel: "result",
        data: "x".repeat(HOST_FRAME_BYTES),
      }),
    ).toThrow("too large");
  });
  it("keeps path, exact selected lines and the instruction in a normal message", () => {
    expect(
      ideHandoffText({
        path: "/project/a.ts",
        startLine: 3,
        endLine: 4,
        selection: "first\nsecond",
        instruction: "  Explain this  ",
      }),
    ).toBe("Explain this\n\n/project/a.ts:3-4\n\nfirst\nsecond");
    expect(IdePathSchema.safeParse("nested/../other").success).toBe(false);
  });
});
