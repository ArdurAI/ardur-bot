/*
 * Adapted from opencode session-panel-width.ts and session-panel-layout.ts:
 * https://github.com/sst/opencode/tree/2fa3363c924c5c3e367b84a87ae478296a0ed59b/packages/app/src/pages/session
 * MIT License — Copyright (c) 2025 opencode
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
export function clampWorkspacePanelSize(input: {
  size: number;
  available: number | undefined;
  stacked: boolean;
}) {
  const min = input.stacked ? 200 : 360;
  const max = input.stacked ? 600 : 800;
  const reserve = input.stacked ? 280 : 400;
  // Keep the stored desktop size until the row is measured; never persist the
  // temporary size imposed by a smaller window or the phone overlay.
  const limit =
    input.available === undefined ? max : Math.min(max, Math.max(min, input.available - reserve));
  return Math.max(min, Math.min(input.size, limit));
}
export function workspacePanelLayout(input: {
  open: boolean;
  expanded: boolean;
  narrow: boolean;
  available: number | undefined;
  position: "right" | "left" | "bottom";
}) {
  return {
    visible: input.open,
    stacked: input.position === "bottom",
    overlay:
      input.expanded || input.narrow || (input.available !== undefined && input.available < 760),
  };
}
