import type { DisplayFrame, PixelSize } from "../shared/types";
import { isRotation, validSize } from "../shared/screen-coordinates";

// Best-effort parser for Android's diagnostic text, not a stable public API.
// Only accept explicit default-display, zero-origin logical frames; do not guess
// from wm physical size, aspect ratio, external displays or an arbitrary viewport.
export function parseInputDisplay(text: string): DisplayFrame | null {
  const frames: DisplayFrame[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/\bViewport INTERNAL:/.test(line) || !/\bdisplayId=0(?:,|\s)/.test(line) || /\bisActive=\[?0\]?/.test(line)) continue;
    const rotation = Number(line.match(/\borientation=(\d+)\b/)?.[1] ?? -1);
    const match = line.match(/\blogicalFrame=\[\s*0,\s*0,\s*(\d+),\s*(\d+)\s*\]/);
    if (!match || !isRotation(rotation)) continue;
    const frame = { rotation, width: Number(match[1]), height: Number(match[2]) };
    if (validSize(frame)) frames.push(frame);
  }
  const first = frames[0];
  // Dumpsys repeats viewports. Conflicting copies can indicate a transition.
  return first && frames.every(frame => frame.rotation === first.rotation && frame.width === first.width && frame.height === first.height) ? first : null;
}

// Validate the PNG signature/IHDR before handing bytes to the renderer. This is
// a header check, not a full PNG decoder; the preview also handles decode errors.
export function pngSize(data: Buffer): PixelSize | null {
  if (data.length < 33 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || data.readUInt32BE(8) !== 13 || data.toString("ascii", 12, 16) !== "IHDR") return null;
  const size = { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  return validSize(size) ? size : null;
}
