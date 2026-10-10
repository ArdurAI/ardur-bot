import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { deviceEventEndFrame, deviceEventFrame } from "./device-event-stream.js";
import {
  DEVICE_EVENT_WINDOW,
  DeviceEventsInputSchema,
  DeviceEventWindowEndSchema,
} from "./dispatch.js";
import { ProductEventSchema } from "./events.js";
import type { DeviceEventWindowEnd, ProductEvent } from "./index.js";

const fixtures = JSON.parse(
  readFileSync(
    new URL("../../../apps/cli/fixtures/device-operations.json", import.meta.url),
    "utf8",
  ),
) as {
  eventWindow: typeof DEVICE_EVENT_WINDOW;
  requests: { operation: string; body: unknown }[];
  eventStreams: {
    name: string;
    startCursor: number;
    wire: string;
    utf8HexChunks: string[];
    expectedEvents: ProductEvent[];
    expectedWindow: DeviceEventWindowEnd | null;
    expectedCursor: number;
  }[];
};
it("publishes the actual response bounds and validates signed bot and room event requests", () => {
  expect(fixtures.eventWindow).toEqual(DEVICE_EVENT_WINDOW);
  const requests = fixtures.requests.filter((row) => row.operation === "events");
  expect(requests).toHaveLength(3);
  for (const row of requests)
    expect(DeviceEventsInputSchema.safeParse(row.body).success).toBe(true);
});
it.each(fixtures.eventStreams)(
  "publishes complete byte chunks and expected frames for $name",
  (vector) => {
    const bytes = Buffer.concat(vector.utf8HexChunks.map((hex) => Buffer.from(hex, "hex")));
    expect(bytes.toString("utf8")).toBe(vector.wire);
    expect(bytes.length).toBeLessThanOrEqual(DEVICE_EVENT_WINDOW.maxBytes);
    const frames = vector.wire.split("\n\n");
    frames.pop(); // Incomplete trailing data is discarded on disconnect.
    let cursor = vector.startCursor;
    const events: ProductEvent[] = [];
    let window: DeviceEventWindowEnd | null = null;
    for (const frame of frames) {
      if (frame.startsWith(":")) continue;
      const data = frame
        .split("\n")
        .find((line) => line.startsWith("data: "))!
        .slice(6);
      if (frame.includes("event: window")) {
        window = DeviceEventWindowEndSchema.parse(JSON.parse(data));
        expect(`${frame}\n\n`).toBe(deviceEventEndFrame(window));
        expect(window.nextCursor).toBeGreaterThanOrEqual(cursor);
        cursor = window.nextCursor;
      } else {
        const raw: ProductEvent = JSON.parse(data);
        const event = ProductEventSchema.parse(raw);
        expect(`${frame}\n\n`).toBe(deviceEventFrame(raw));
        if (event.seq <= cursor) continue;
        events.push(event);
        cursor = event.seq;
      }
    }
    expect(events).toEqual(vector.expectedEvents);
    expect(window).toEqual(vector.expectedWindow);
    expect(cursor).toBe(vector.expectedCursor);
  },
);
