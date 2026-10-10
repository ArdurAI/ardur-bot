import type { DeviceEventWindowEnd } from "./dispatch.js";
import type { ProductEvent } from "./events.js";

export function deviceEventFrame(event: ProductEvent): string {
  return `id: ${event.seq}\nevent: event\ndata: ${JSON.stringify(event)}\n\n`;
}
export function deviceEventEndFrame(end: DeviceEventWindowEnd): string {
  return `event: window\ndata: ${JSON.stringify(end)}\n\n`;
}
