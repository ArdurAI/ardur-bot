import type { TaskCard } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import {
  peerCardReadInput,
  peerReadOnlyRuntimeSupported,
  peerReadOnlyToolAllowed,
} from "./peer-policy.js";

describe("goal desk policy", () => {
  it("permits only card reporting and result transport", () => {
    for (const name of [
      "report_progress",
      "attach_artifact",
      "complete_task",
      "message_bot",
      "read_file",
    ])
      expect(peerReadOnlyToolAllowed(name)).toBe(true);
    for (const name of [
      "shell",
      "write_file",
      "request_secret",
      "spawn_bot",
      "ask_user",
      "web_fetch",
      "mcp_write",
    ])
      expect(peerReadOnlyToolAllowed(name)).toBe(false);
  });

  it("restricts reads to exact card references", () => {
    const card = {
      inputs: [
        { type: "file", artifactId: "file-1" },
        { type: "document", documentId: "doc-1", revision: 2 },
      ],
    } as TaskCard;
    expect(peerCardReadInput(card, "artifact:file-1")).toEqual(card.inputs[0]);
    expect(peerCardReadInput(card, "document:doc-1@2")).toEqual(card.inputs[1]);
    expect(peerCardReadInput(card, "document:doc-1@1")).toBeUndefined();
    expect(peerCardReadInput(card, "notes/private.txt")).toBeUndefined();
  });

  it("refuses runtimes without the S1 tool boundary", () => {
    expect(peerReadOnlyRuntimeSupported("pi")).toBe(true);
    expect(peerReadOnlyRuntimeSupported("native")).toBe(false);
    expect(peerReadOnlyRuntimeSupported("")).toBe(false);
  });
});
