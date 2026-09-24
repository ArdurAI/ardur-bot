import { describe, expect, it, vi } from "vitest";
import { pickComposerFolder, splitComposerDrop } from "./folders";

describe("composer folder references", () => {
  it("attaches the path returned by the same host picker as Settings", async () => {
    const host = {
      state: vi.fn(),
      setup: vi.fn(),
      removeRoot: vi.fn(),
      clear: vi.fn(),
      addRoot: vi.fn().mockResolvedValue("/fixture/reports"),
      addDroppedRoot: vi.fn().mockResolvedValue("/fixture/dropped"),
    };
    expect(await pickComposerFolder(host)).toEqual({
      kind: "folder",
      id: "/fixture/reports",
      name: "reports",
    });
    const file = new File([], "dropped");
    expect(await pickComposerFolder(host, file)).toEqual({
      kind: "folder",
      id: "/fixture/dropped",
      name: "dropped",
    });
    expect(host.addDroppedRoot).toHaveBeenCalledWith(file);
    host.addRoot.mockResolvedValue(null);
    expect(await pickComposerFolder(host)).toBeNull();
  });
  it("separates directories from files without traversing them", () => {
    const folder = new File([], "reports");
    const image = new File(["image"], "photo.png", { type: "image/png" });
    const transfer = {
      items: [folder, image].map((file, index) => ({
        kind: "file",
        getAsFile: () => file,
        webkitGetAsEntry: () => ({ isDirectory: index === 0 }),
      })),
      files: [folder, image],
    } as unknown as DataTransfer;
    expect(splitComposerDrop(transfer)).toEqual({ files: [image], folders: [folder] });
  });
});
