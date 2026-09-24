import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8"),
) as {
  productName?: string;
  build: {
    productName?: string;
    extraResources: { from: string; to: string; filter?: string[] }[];
  };
};

describe("desktop package metadata", () => {
  it("shares the customer-facing name between Electron and electron-builder", () => {
    expect(packageJson.productName).toBe("Ardur Bot");
    expect(packageJson.build?.productName).toBeUndefined();
  });

  it("packs the matching native addon beside the single host bundle", () => {
    expect(packageJson.build.extraResources).toContainEqual({
      from: "../host-service/dist/host-service.cjs",
      to: "host-service/host-service.cjs",
    });
    const native = packageJson.build.extraResources.filter((resource) =>
      resource.from.includes("/native/"),
    );
    expect(native).toEqual([
      {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder expands these macros.
        from: "../host-service/dist/native/${os}_${arch}",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder expands these macros.
        to: "host-service/native/${os}_${arch}",
        filter: ["koffi.node"],
      },
    ]);
  });
});
