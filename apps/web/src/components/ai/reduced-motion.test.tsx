import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Shimmer, SuccessPop } from "./primitives";

describe("shell reduced motion", () => {
  it("keeps shimmer readable and both success animations static", () => {
    const shimmer = renderToString(<Shimmer>Working</Shimmer>);
    expect(shimmer).toContain("motion-reduce:animate-none");
    expect(shimmer).toContain("motion-reduce:bg-none");
    expect(shimmer).toContain("motion-reduce:text-muted-foreground");
    const success = renderToString(<SuccessPop label="Done" />);
    expect(success.match(/motion-reduce:animate-none/g)).toHaveLength(2);
  });
  it("animates only transform and opacity on the fixed-width panel", () => {
    const source = readFileSync(
      new URL("../../../../../packages/ui-web/src/sliding-panel.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain("transition-[transform,opacity]");
    expect(source).toContain("motion-reduce:transition-none");
    expect(source).not.toMatch(/transition-all|transition-\[width/);
    expect(source).toContain("inert={!open}");
  });
});
