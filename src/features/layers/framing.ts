import type { LayerRecord } from "../../../shared/layer-layout";
import { clipBounds } from "../../../shared/screen-coordinates";
import type { PixelSize } from "../../../shared/types";

export type LayerFramingScope = "screen" | "all";

// Available scene geometry and the range fitted by the camera are independent.
// Normal inspection stays anchored to the current screen; a focus or an explicit
// overview uses the complete bounds of its working set.
export function layerFraming(records: readonly LayerRecord[], size: PixelSize, screenOnly: boolean) {
  const frames = records.flatMap(record => {
    const bounds = screenOnly ? clipBounds(record.renderBounds, size) : record.renderBounds;
    return bounds ? [{ bounds, z: record.z }] : [];
  });
  const center = {
    x: frames.length ? (Math.min(...frames.map(r => r.bounds.left)) + Math.max(...frames.map(r => r.bounds.right))) / 2 : size.width / 2,
    y: frames.length ? (Math.min(...frames.map(r => r.bounds.top)) + Math.max(...frames.map(r => r.bounds.bottom))) / 2 : size.height / 2,
    z: frames.length ? (Math.min(...frames.map(r => r.z)) + Math.max(...frames.map(r => r.z))) / 2 : 0,
  };
  return { frames, center };
}
